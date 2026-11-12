/**
 * dsh-llm-nearai-tee — a small DeepSeek Harness LLM adapter that routes one
 * provider (`nearai-e2ee`) through NEAR AI's verified, end-to-end-encrypted
 * Chat Completions transport.
 *
 * Security boundary (after the streaming change):
 *  - `e2ee: true` is hardcoded; there is no configuration that disables it.
 *  - The SDK verifies Gateway and model TEE attestation before the request is
 *    sent, and refuses Incognito models when E2EE is enabled.
 *  - Text and reasoning deltas are shown live, as requested by the operator.
 *  - Tool calls are buffered and never emitted until `verifyResponse(id)`
 *    succeeds and the receipt says `provider_tee`. A failed verification
 *    latches a profile-wide lockout for subsequent requests.
 *  - No fallback provider, model, or plaintext request path exists.
 *
 * The adapter intentionally has no runtime import from `@deepseek-ai/dsh-llm`:
 * it implements the adapter shape structurally and raises errors carrying the
 * host's `failure`/`code` fields. That keeps the bundle self-contained.
 */
import { InferenceClient } from "@nearai/inference-sdk/node";
const PROVIDER = "nearai-e2ee";
const DISPLAY_NAME = "NEAR AI — Verified Private TEE (E2EE)";
const BASE_URL = "https://cloud-api.near.ai/v1";
const USER_AGENT = "dsh-llm-nearai-tee/0.2.0";
/** The only model IDs this route will ever send. */
const MODELS = [
    {
        id: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
        name: "DeepSeek V4.1 Flash — Private TEE, E2EE",
    },
    {
        id: "deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated",
        name: "DeepSeek V4.1 Flash Abliterated — Private TEE, E2EE",
    },
];
/**
 * Reasoning-effort choices advertised to Harness, with the exact NEAR AI wire
 * value each one sends. NEAR AI's "medium" maps onto "high", so it is not
 * offered separately: one picker row per distinct wire value.
 */
const REASONING_EFFORTS = [
    {
        id: "none",
        wire: "none",
        name: "Off",
        description: "Disable reasoning (sends \"none\").",
    },
    { id: "low", wire: "low", name: "Low", description: "Favor shorter reasoning." },
    { id: "high", wire: "high", name: "High", description: "Favor deeper reasoning." },
    { id: "max", wire: "max", name: "Max", description: "Maximum reasoning depth." },
];
function wireEffort(effort) {
    return REASONING_EFFORTS.find((candidate) => candidate.id === effort)?.wire;
}
/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */
/**
 * Error shape the host understands: an own `code` plus an own `failure`
 * snapshot. The host adopts `failure` only when its code equals `code`, so
 * both are set to the same stable machine code.
 */
export class NearAiE2eeError extends Error {
    code;
    failure;
    constructor(message, code, options = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "NearAiE2eeError";
        this.code = code;
        this.failure = Object.freeze({
            message,
            code,
            ...(options.status === undefined ? {} : { status: options.status }),
        });
    }
}
function fail(code, message, options = {}) {
    return new NearAiE2eeError(message, code, options);
}
function aborted(cause) {
    return fail("ABORTED", "NEAR AI request was cancelled.", { cause });
}
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
function integer(value, fallback, min, max, name) {
    if (value === undefined)
        return fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`nearai-e2ee: ${name} must be an integer from ${min} through ${max}.`);
    }
    return value;
}
function resolveConfig(raw) {
    const apiKeyEnv = raw.apiKeyEnv ?? "NEARAI_API_KEY";
    if (typeof apiKeyEnv !== "string" || !ENV_NAME.test(apiKeyEnv)) {
        throw new Error("nearai-e2ee: apiKeyEnv must be an environment variable name.");
    }
    return {
        maxOutputTokens: integer(raw.maxOutputTokens, 2_048, 1, 131_072, "maxOutputTokens"),
        maxConcurrentRequests: integer(raw.maxConcurrentRequests, 25, 1, 64, "maxConcurrentRequests"),
        requestTimeoutMs: integer(raw.requestTimeoutMs, 300_000, 1_000, 600_000, "requestTimeoutMs"),
        attestationCacheTimeToLiveMs: integer(raw.attestationCacheTimeToLiveMs, 3_600_000, 0, 86_400_000, "attestationCacheTimeToLiveMs"),
        responseCacheTimeToLiveMs: integer(raw.responseCacheTimeToLiveMs, 3_600_000, 60_000, 86_400_000, "responseCacheTimeToLiveMs"),
        contextWindow: integer(raw.contextWindow, 1_000_000, 1, 10_000_000, "contextWindow"),
        apiKeyEnv,
    };
}
/** Read a field from the SDK's typed `failure.details` without trusting it. */
function failureDetail(failure, field) {
    const details = failure?.details;
    if (typeof details !== "object" || details === null)
        return undefined;
    return details[field];
}
const createSdkClient = (options) => new InferenceClient(options);
/* ------------------------------------------------------------------ */
/* API key                                                             */
/* ------------------------------------------------------------------ */
const KEY_PATTERN = /^[\x21-\x7E]+$/;
function checkedKey(value, source) {
    const trimmed = value.trim();
    if (!KEY_PATTERN.test(trimmed)) {
        throw fail("INVALID_API_KEY", `The NEAR AI key from ${source} contains characters that cannot be sent in an HTTP header.`);
    }
    return trimmed;
}
/* ------------------------------------------------------------------ */
/* Concurrency + timeout                                               */
/* ------------------------------------------------------------------ */
class SlotQueue {
    limit;
    active = 0;
    waiting = [];
    constructor(limit) {
        this.limit = limit;
    }
    async acquire(signal) {
        if (signal?.aborted)
            throw aborted();
        if (this.active < this.limit) {
            this.active += 1;
            return;
        }
        await new Promise((resolve, reject) => {
            const wake = () => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
            };
            const onAbort = () => {
                const index = this.waiting.indexOf(wake);
                if (index >= 0)
                    this.waiting.splice(index, 1);
                reject(aborted());
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            this.waiting.push(wake);
        });
        this.active += 1;
    }
    release() {
        this.active = Math.max(0, this.active - 1);
        this.waiting.shift()?.();
    }
}
function callerAborted(signal) {
    return signal?.aborted === true;
}
function requestSignal(signal, timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (signal === undefined) {
        return { signal: timeout, timedOut: () => timeout.aborted };
    }
    return {
        signal: AbortSignal.any([signal, timeout]),
        timedOut: () => timeout.aborted,
    };
}
/* ------------------------------------------------------------------ */
/* Error mapping — never include response bodies or prompt text        */
/* ------------------------------------------------------------------ */
function sdkFailureOf(error) {
    if (typeof error !== "object" || error === null)
        return undefined;
    const failure = error.failure;
    if (typeof failure !== "object" || failure === null)
        return undefined;
    return failure;
}
function mapSdkError(error, phase, timedOut, callerAborted) {
    if (callerAborted)
        return aborted(error);
    if (timedOut)
        return fail("TIMEOUT", "NEAR AI request timed out.", { cause: error });
    const failure = sdkFailureOf(error);
    const sdkCode = typeof failure?.code === "string" ? failure.code : undefined;
    // The SDK carries an HTTP status inside `failure.details.status` on
    // `api.http_status`; `failure.status` is not populated by this version.
    const detailStatus = failureDetail(failure, "status");
    const status = typeof failure?.status === "number"
        ? failure.status
        : typeof detailStatus === "number"
            ? detailStatus
            : undefined;
    if (sdkCode === "api.transport_failed") {
        return fail("TRANSPORT", "Could not reach NEAR AI.", { cause: error });
    }
    if (phase === "verify") {
        return fail("RESPONSE_VERIFICATION_FAILED", `NEAR AI response verification failed${sdkCode === undefined ? "" : ` (${sdkCode})`}.`, { cause: error });
    }
    if (sdkCode !== undefined && sdkCode.includes("completion_not_found")) {
        return fail("RESPONSE_VERIFICATION_FAILED", "NEAR AI no longer retains the verification record for this response.", { cause: error });
    }
    if (status === 401 || status === 403) {
        return fail("AUTH", "NEAR AI rejected the API key.", { cause: error, status });
    }
    if (status === 429) {
        return fail("RATE_LIMIT", "NEAR AI rate limit reached.", { cause: error, status });
    }
    if (status !== undefined && status >= 500) {
        return fail("SERVER", "NEAR AI returned a server error.", { cause: error, status });
    }
    if (sdkCode !== undefined) {
        return fail("INVALID_REQUEST", `NEAR AI rejected the request (${sdkCode}).`, { cause: error, status });
    }
    if (error instanceof TypeError) {
        return fail("TRANSPORT", "Could not reach NEAR AI.", { cause: error });
    }
    return fail("PROVIDER_ERROR", "NEAR AI request failed.", { cause: error });
}
function isStreamSecurityFailure(error) {
    const code = sdkFailureOf(error)?.code;
    if (typeof code === "string" &&
        (code.startsWith("e2ee.") || code.startsWith("signature."))) {
        return code;
    }
    return undefined;
}
/* ------------------------------------------------------------------ */
/* Request translation                                                 */
/* ------------------------------------------------------------------ */
function textOf(message) {
    return message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
}
function reasoningOf(message) {
    return message.content
        .filter((block) => block.type === "reasoning")
        .map((block) => block.text)
        .join("");
}
function toolCallsOf(message) {
    return message.content
        .filter((block) => block.type === "tool-call")
        .map((block) => {
        if (typeof block.id !== "string" || block.id.length === 0) {
            throw fail("INVALID_REQUEST", "An assistant tool call is missing its id.");
        }
        return { id: block.id, name: block.name, arguments: block.arguments };
    });
}
function reminder(text) {
    return `<system-reminder>\n${text.replaceAll("</system-reminder>", "<\\/system-reminder>")}\n</system-reminder>`;
}
function translateMessages(options) {
    const systemParts = [];
    if (typeof options.system === "string" && options.system.trim().length > 0) {
        systemParts.push(options.system);
    }
    // Leading system/developer messages belong to the prompt, not the turn.
    let cursor = 0;
    while (cursor < options.messages.length &&
        (options.messages[cursor].role === "system" || options.messages[cursor].role === "developer")) {
        const text = textOf(options.messages[cursor]);
        if (text.trim().length > 0)
            systemParts.push(text);
        cursor += 1;
    }
    const out = [];
    if (systemParts.length > 0) {
        out.push({ role: "system", content: systemParts.join("\n\n") });
    }
    for (; cursor < options.messages.length; cursor += 1) {
        const message = options.messages[cursor];
        if (message.role === "system" || message.role === "developer") {
            const text = textOf(message);
            if (text.trim().length > 0)
                out.push({ role: "user", content: reminder(text) });
            continue;
        }
        if (message.role === "tool") {
            if (typeof message.toolCallId !== "string" || message.toolCallId.length === 0) {
                throw fail("INVALID_REQUEST", "A tool result message is missing its tool call id.");
            }
            out.push({
                role: "tool",
                tool_call_id: message.toolCallId,
                content: textOf(message) || "(no output)",
            });
            continue;
        }
        if (message.role === "assistant") {
            const text = textOf(message);
            const reasoning = reasoningOf(message);
            const calls = toolCallsOf(message);
            const assistant = {
                role: "assistant",
                content: text.length > 0 ? text : calls.length > 0 ? null : "",
            };
            if (reasoning.length > 0)
                assistant.reasoning_content = reasoning;
            if (calls.length > 0) {
                assistant.tool_calls = calls.map((call) => ({
                    id: call.id,
                    type: "function",
                    function: { name: call.name, arguments: call.arguments },
                }));
            }
            out.push(assistant);
            continue;
        }
        out.push({ role: "user", content: textOf(message) });
    }
    return out;
}
function buildRequestBody(options, model, config) {
    const messages = translateMessages(options);
    const body = {
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: options.maxTokens ?? config.maxOutputTokens,
    };
    const tools = (options.tools ?? [])
        .filter((tool) => tool.deferLoading !== true)
        .map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }));
    if (tools.length > 0) {
        body.tools = tools;
        body.tool_choice = "auto";
    }
    if (options.temperature !== undefined)
        body.temperature = options.temperature;
    if (options.stop !== undefined)
        body.stop = [...options.stop];
    if (options.reasoningEffort !== undefined) {
        body.reasoning_effort = options.reasoningEffort;
    }
    return body;
}
/* ------------------------------------------------------------------ */
/* Response parsing                                                    */
/* ------------------------------------------------------------------ */
function asRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function positiveInteger(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : undefined;
}
function mapUsage(value) {
    const usageRecord = asRecord(value);
    if (usageRecord === undefined)
        return undefined;
    const prompt = positiveInteger(usageRecord.prompt_tokens) ?? 0;
    const output = positiveInteger(usageRecord.completion_tokens) ?? 0;
    const total = positiveInteger(usageRecord.total_tokens) ?? prompt + output;
    const promptDetails = asRecord(usageRecord.prompt_tokens_details) ?? {};
    const completionDetails = asRecord(usageRecord.completion_tokens_details) ?? {};
    const cacheRead = positiveInteger(promptDetails.cached_tokens);
    const reasoningTokens = positiveInteger(completionDetails.reasoning_tokens);
    return {
        inputTokens: prompt,
        outputTokens: output,
        totalTokens: total,
        ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
        ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    };
}
function finishFor(finishReason, toolCallCount) {
    if (finishReason === "length")
        return { kind: "max-tokens" };
    if (toolCallCount > 0)
        return { kind: "tool-calls" };
    if (finishReason === "content_filter") {
        return {
            kind: "error",
            failure: { message: "NEAR AI blocked the response.", code: "CONTENT_FILTER" },
        };
    }
    if (finishReason === "tool_calls" || finishReason === "function_call") {
        return {
            kind: "error",
            failure: {
                message: "NEAR AI reported tool calls but returned none.",
                code: "MALFORMED_RESPONSE",
            },
        };
    }
    if (finishReason === "error") {
        return {
            kind: "error",
            failure: { message: "NEAR AI reported an error finish.", code: "PROVIDER_ERROR" },
        };
    }
    return { kind: "stop" };
}
export class NearAiE2eeAdapter {
    #config;
    #createClient;
    #resolveStoredKey;
    #slots;
    #client;
    #clientKey;
    #lockout;
    constructor(config = {}, deps = {}) {
        this.#config = resolveConfig(config);
        this.#createClient = deps.createClient ?? createSdkClient;
        this.#resolveStoredKey = deps.resolveStoredKey;
        this.#slots = new SlotQueue(this.#config.maxConcurrentRequests);
    }
    providerInfo(provider) {
        if (provider !== PROVIDER) {
            throw fail("INVALID_PROVIDER", `nearai-e2ee does not own provider "${provider}".`);
        }
        return { id: PROVIDER, name: DISPLAY_NAME };
    }
    providerRetryPolicy(provider) {
        if (provider !== PROVIDER) {
            throw fail("INVALID_PROVIDER", `nearai-e2ee does not own provider "${provider}".`);
        }
        // Zero automatic retries: a security failure must never be retried, and a
        // paid request should not be repeated without the caller asking.
        return Object.freeze({
            mode: "normal",
            maxRetries: 0,
            retryableCodes: Object.freeze(["RATE_LIMIT"]),
            backoff: Object.freeze({
                initialDelayMs: 500,
                maxDelayMs: 10_000,
                jitterRatio: 0.1,
            }),
        });
    }
    listModels(provider) {
        if (provider !== PROVIDER) {
            throw fail("INVALID_PROVIDER", `nearai-e2ee does not own provider "${provider}".`);
        }
        return Promise.resolve(MODELS.map((model) => ({
            provider: PROVIDER,
            id: model.id,
            name: model.name,
            inputModalities: ["text"],
        })));
    }
    async resolveModel(provider, model) {
        if (provider !== PROVIDER) {
            throw fail("INVALID_PROVIDER", `nearai-e2ee does not own provider "${provider}".`);
        }
        const known = MODELS.find((candidate) => candidate.id === model);
        if (known === undefined) {
            throw fail("INVALID_MODEL", `nearai-e2ee only serves the allowlisted NEAR AI DeepSeek models; refusing "${model}".`);
        }
        return {
            provider: PROVIDER,
            id: known.id,
            name: known.name,
            inputModalities: ["text"],
            context: { contextWindow: this.#config.contextWindow },
            defaultMaxTokens: this.#config.maxOutputTokens,
            reasoning: {
                efforts: REASONING_EFFORTS.map(({ id, name, description }) => ({
                    id,
                    name,
                    description,
                })),
            },
        };
    }
    async prepareCall(provider, model) {
        return {
            model: await this.resolveModel(provider, model),
            stream: (options) => this.stream(options),
        };
    }
    async *stream(options) {
        if (this.#lockout !== undefined) {
            throw fail("VERIFICATION_LOCKOUT", this.#lockout);
        }
        if (options.provider !== PROVIDER) {
            throw fail("INVALID_PROVIDER", `nearai-e2ee does not own provider "${options.provider}".`);
        }
        if (options.reasoningEffort !== undefined &&
            wireEffort(options.reasoningEffort) === undefined) {
            throw fail("UNSUPPORTED_OPTION", `nearai-e2ee does not support reasoning effort "${options.reasoningEffort}"; ` +
                `use ${REASONING_EFFORTS.map((effort) => effort.id).join(", ")}.`);
        }
        if (!MODELS.some((model) => model.id === options.model)) {
            throw fail("INVALID_MODEL", `nearai-e2ee only serves the allowlisted NEAR AI DeepSeek models; refusing "${options.model}".`);
        }
        const apiKey = await this.#resolveApiKey();
        const client = this.#clientFor(apiKey);
        await this.#slots.acquire(options.signal);
        try {
            const { signal, timedOut } = requestSignal(options.signal, this.#config.requestTimeoutMs);
            const body = buildRequestBody(options, options.model, this.#config);
            let stream;
            try {
                stream = await client.chat.completions.create(body, { signal });
            }
            catch (error) {
                throw mapSdkError(error, "request", timedOut(), callerAborted(options.signal));
            }
            let completionId;
            let finishReason = null;
            let usage;
            let sawUsage = false;
            let nextIndex = 0;
            let reasoningIndex;
            let textIndex;
            let reasoningText = "";
            let textText = "";
            const toolCalls = new Map();
            try {
                for await (const chunk of stream) {
                    if (signal.aborted)
                        throw aborted();
                    if (completionId === undefined &&
                        typeof chunk.id === "string" &&
                        chunk.id.length > 0) {
                        completionId = chunk.id;
                    }
                    if (chunk.usage !== undefined) {
                        const mapped = mapUsage(chunk.usage);
                        if (mapped !== undefined) {
                            usage = mapped;
                            sawUsage = true;
                        }
                    }
                    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
                    const choice = asRecord(choices[0]);
                    if (choice === undefined)
                        continue;
                    const delta = asRecord(choice.delta) ?? {};
                    const reasoningDelta = typeof delta.reasoning_content === "string"
                        ? delta.reasoning_content
                        : typeof delta.reasoning === "string"
                            ? delta.reasoning
                            : "";
                    if (reasoningDelta.length > 0) {
                        if (reasoningIndex === undefined) {
                            reasoningIndex = nextIndex;
                            nextIndex += 1;
                            yield {
                                type: "block-start",
                                index: reasoningIndex,
                                blockType: "reasoning",
                            };
                        }
                        reasoningText += reasoningDelta;
                        yield {
                            type: "reasoning-delta",
                            index: reasoningIndex,
                            text: reasoningDelta,
                        };
                    }
                    const contentDelta = typeof delta.content === "string" ? delta.content : "";
                    if (contentDelta.length > 0) {
                        if (textIndex === undefined) {
                            textIndex = nextIndex;
                            nextIndex += 1;
                            yield { type: "block-start", index: textIndex, blockType: "text" };
                        }
                        textText += contentDelta;
                        yield { type: "text-delta", index: textIndex, text: contentDelta };
                    }
                    if (Array.isArray(delta.tool_calls)) {
                        for (const raw of delta.tool_calls) {
                            const record = asRecord(raw);
                            if (record === undefined)
                                continue;
                            const index = typeof record.index === "number" ? record.index : toolCalls.size;
                            let accumulated = toolCalls.get(index);
                            if (accumulated === undefined) {
                                accumulated = { id: "", name: "", arguments: "" };
                                toolCalls.set(index, accumulated);
                            }
                            if (typeof record.id === "string" &&
                                record.id.length > 0 &&
                                accumulated.id.length === 0) {
                                accumulated.id = record.id;
                            }
                            const fn = asRecord(record.function);
                            if (fn !== undefined) {
                                if (typeof fn.name === "string" &&
                                    fn.name.length > 0 &&
                                    accumulated.name.length === 0) {
                                    accumulated.name = fn.name;
                                }
                                if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
                                    accumulated.arguments += fn.arguments;
                                }
                            }
                        }
                    }
                    if (typeof choice.finish_reason === "string") {
                        finishReason = choice.finish_reason;
                    }
                }
            }
            catch (error) {
                if (callerAborted(options.signal))
                    throw aborted(error);
                const securityCode = isStreamSecurityFailure(error);
                if (securityCode !== undefined) {
                    this.#latch(`the response stream failed ${securityCode}`);
                    throw fail("RESPONSE_VERIFICATION_FAILED", `NEAR AI stream security check failed (${securityCode}).`, { cause: error });
                }
                throw mapSdkError(error, "request", timedOut(), false);
            }
            if (callerAborted(options.signal))
                throw aborted();
            if (completionId === undefined) {
                this.#latch("the completion had no verification id");
                throw fail("RESPONSE_VERIFICATION_FAILED", "NEAR AI returned a completion without a verification id.");
            }
            let signatureKind;
            try {
                const verified = await client.verifyResponse(completionId);
                signatureKind = verified.signatureKind;
            }
            catch (error) {
                if (callerAborted(options.signal))
                    throw aborted(error);
                this.#latch("the receipt could not be verified");
                throw mapSdkError(error, "verify", false, false);
            }
            if (callerAborted(options.signal))
                throw aborted();
            if (signatureKind !== "provider_tee") {
                this.#latch("the receipt was not a model TEE receipt");
                throw fail("GATEWAY_SIGNATURE_REJECTED", "NEAR AI returned a Gateway receipt, not a model TEE receipt; refusing the completion.");
            }
            // The model signature is verified. Close the live blocks, then release
            // the buffered tool calls.
            if (reasoningIndex !== undefined) {
                yield {
                    type: "block-end",
                    index: reasoningIndex,
                    block: { type: "reasoning", text: reasoningText },
                };
            }
            if (textIndex !== undefined) {
                yield {
                    type: "block-end",
                    index: textIndex,
                    block: { type: "text", text: textText },
                };
            }
            const orderedCalls = [...toolCalls.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, call]) => call);
            if (textText.length === 0 && reasoningText.length === 0 && orderedCalls.length === 0) {
                throw fail("EMPTY_RESPONSE", "NEAR AI returned a completed response with no content.");
            }
            for (const call of orderedCalls) {
                if (call.id.length === 0 || call.name.length === 0) {
                    throw fail("MALFORMED_RESPONSE", "NEAR AI returned an incomplete tool call.");
                }
                const index = nextIndex;
                nextIndex += 1;
                yield { type: "block-start", index, blockType: "tool-call" };
                yield {
                    type: "tool-call-delta",
                    index,
                    id: call.id,
                    name: call.name,
                    argumentsDelta: call.arguments,
                };
                yield {
                    type: "block-end",
                    index,
                    block: {
                        type: "tool-call",
                        id: call.id,
                        name: call.name,
                        arguments: call.arguments,
                    },
                };
            }
            yield {
                type: "usage",
                usage: sawUsage && usage !== undefined
                    ? usage
                    : { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            };
            yield {
                type: "finish",
                reason: finishFor(finishReason, orderedCalls.length),
            };
        }
        finally {
            this.#slots.release();
        }
    }
    #latch(reason) {
        if (this.#lockout === undefined) {
            this.#lockout =
                `A previous NEAR AI response failed verification (${reason}). ` +
                    "Refusing further requests until Harness is restarted or this plugin is reloaded.";
        }
    }
    async #resolveApiKey() {
        if (this.#resolveStoredKey !== undefined) {
            try {
                const stored = await this.#resolveStoredKey();
                if (typeof stored === "string" && stored.trim().length > 0) {
                    return checkedKey(stored, "the Harness credential store");
                }
            }
            catch {
                // Fall through to the environment; the store may be unavailable.
            }
        }
        const names = [
            ...new Set([this.#config.apiKeyEnv, "NEARAI_API_KEY", "NEAR_AI_API_KEY"]),
        ];
        for (const name of names) {
            const value = process.env[name]?.trim();
            if (value !== undefined && value.length > 0)
                return checkedKey(value, name);
        }
        throw fail("MISSING_API_KEY", `NEAR AI API key is not configured. Add it to the Harness credential store as ` +
            `${this.#config.apiKeyEnv} (or NEAR_AI_API_KEY), or set ${this.#config.apiKeyEnv} ` +
            "in the environment that launches Harness.");
    }
    #clientFor(apiKey) {
        if (this.#client !== undefined && this.#clientKey === apiKey)
            return this.#client;
        const client = this.#createClient({
            apiKey,
            baseUrl: BASE_URL,
            e2ee: true,
            attestationCacheTimeToLiveMs: this.#config.attestationCacheTimeToLiveMs,
            responseCacheTimeToLiveMs: this.#config.responseCacheTimeToLiveMs,
            headers: { "user-agent": USER_AGENT },
        });
        this.#client = client;
        this.#clientKey = apiKey;
        return client;
    }
}
export const inject = ["llm"];
export function apply(ctx, config = {}) {
    const names = [
        ...new Set([config.apiKeyEnv ?? "NEARAI_API_KEY", "NEARAI_API_KEY", "NEAR_AI_API_KEY"]),
    ];
    const resolveStoredKey = async () => {
        const live = ctx.get?.("credentials");
        if (live === undefined)
            return undefined;
        for (const name of names) {
            try {
                const hit = await live.resolve(name);
                if (typeof hit?.value === "string" && hit.value.trim().length > 0) {
                    return hit.value;
                }
            }
            catch {
                continue;
            }
        }
        return undefined;
    };
    const adapter = new NearAiE2eeAdapter(config, { resolveStoredKey });
    ctx.llm.registerAdapter([PROVIDER], adapter);
}
