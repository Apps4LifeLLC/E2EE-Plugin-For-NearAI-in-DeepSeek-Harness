import test from "node:test";
import assert from "node:assert/strict";

import { NearAiE2eeAdapter, NearAiE2eeError } from "../lib/index.js";

process.env.NEARAI_API_KEY = "test-key-not-real";

const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";

function options(overrides = {}) {
  return {
    provider: "nearai-e2ee",
    model: MODEL,
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    ...overrides,
  };
}

function streamChunks({
  id = "cmpl_1",
  reasoning = "",
  text = "hello",
  toolCalls = [],
  finishReason = "stop",
  usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
} = {}) {
  const chunks = [];
  if (reasoning) {
    chunks.push({
      id,
      choices: [{ delta: { reasoning_content: reasoning }, finish_reason: null }],
    });
  }
  if (text) {
    chunks.push({ id, choices: [{ delta: { content: text }, finish_reason: null }] });
  }
  for (const [index, call] of toolCalls.entries()) {
    chunks.push({
      id,
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index,
                id: call.id,
                function: { name: call.name, arguments: call.arguments },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  }
  chunks.push({ id, choices: [{ delta: {}, finish_reason: finishReason }] });
  if (usage) chunks.push({ id, choices: [], usage });
  return (async function* generate() {
    for (const chunk of chunks) yield chunk;
  })();
}

function fakeClient({ stream, verify, onCreate } = {}) {
  let created = 0;
  return {
    get created() {
      return created;
    },
    chat: {
      completions: {
        create: async (body, requestOptions) => {
          created += 1;
          onCreate?.(body, requestOptions);
          return stream ?? streamChunks({});
        },
      },
    },
    verifyResponse: async (id) => {
      if (verify !== undefined) return verify(id);
      return { signatureKind: "provider_tee" };
    },
  };
}

function adapter(client, config = {}, deps = {}) {
  return new NearAiE2eeAdapter(
    { apiKeyEnv: "NEARAI_API_KEY", ...config },
    { createClient: () => client, ...deps },
  );
}

async function drain(instance, request = options(), sink = []) {
  let error;
  try {
    for await (const chunk of instance.stream(request)) sink.push(chunk);
  } catch (caught) {
    error = caught;
  }
  return { chunks: sink, error };
}

function tick(ms = 25) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("live text flows before verification; tool calls wait for provider_tee", async () => {
  let releaseVerification;
  const pending = new Promise((resolve) => {
    releaseVerification = resolve;
  });
  const client = fakeClient({
    stream: streamChunks({
      reasoning: "plan",
      text: "hello",
      toolCalls: [
        { id: "call_a", name: "read", arguments: '{"path":"a.txt"}' },
        { id: "call_b", name: "write", arguments: '{"path":"b.txt"}' },
      ],
      finishReason: "tool_calls",
    }),
    verify: () => pending,
  });

  const chunks = [];
  const running = drain(adapter(client), options(), chunks);

  await tick();
  assert.ok(chunks.some((chunk) => chunk.type === "reasoning-delta"));
  assert.ok(chunks.some((chunk) => chunk.type === "text-delta"));
  assert.equal(chunks.some((chunk) => chunk.type === "tool-call-delta"), false);
  assert.equal(chunks.some((chunk) => chunk.type === "usage"), false);
  assert.equal(chunks.some((chunk) => chunk.type === "finish"), false);

  releaseVerification({ signatureKind: "provider_tee" });
  const { error } = await running;
  assert.equal(error, undefined);

  const calls = chunks
    .filter((chunk) => chunk.type === "block-end" && chunk.block.type === "tool-call")
    .map((chunk) => chunk.block);
  assert.deepEqual(calls, [
    { type: "tool-call", id: "call_a", name: "read", arguments: '{"path":"a.txt"}' },
    { type: "tool-call", id: "call_b", name: "write", arguments: '{"path":"b.txt"}' },
  ]);
  assert.deepEqual(chunks.at(-1).reason, { kind: "tool-calls" });
  assert.equal(client.created, 1);
});

test("gateway receipt is rejected after live text, and latches a lockout", async () => {
  const client = fakeClient({ verify: async () => ({ signatureKind: "gateway" }) });
  const instance = adapter(client);

  const first = await drain(instance);
  assert.ok(first.chunks.some((chunk) => chunk.type === "text-delta"));
  assert.equal(first.chunks.some((chunk) => chunk.type === "tool-call-delta"), false);
  assert.ok(first.error instanceof NearAiE2eeError);
  assert.equal(first.error.code, "GATEWAY_SIGNATURE_REJECTED");

  const second = await drain(instance);
  assert.equal(second.error.code, "VERIFICATION_LOCKOUT");
  assert.equal(second.chunks.length, 0);
  assert.equal(client.created, 1);
});

test("a failed signature is not retried and latches a lockout", async () => {
  let verifyCalls = 0;
  const client = fakeClient({
    verify: async () => {
      verifyCalls += 1;
      const failure = new Error("signature mismatch");
      failure.failure = { code: "signature.invalid" };
      throw failure;
    },
  });
  const instance = adapter(client);

  const first = await drain(instance);
  assert.ok(first.chunks.some((chunk) => chunk.type === "text-delta"));
  assert.equal(first.error.code, "RESPONSE_VERIFICATION_FAILED");
  assert.equal(client.created, 1);
  assert.equal(verifyCalls, 1);

  const second = await drain(instance);
  assert.equal(second.error.code, "VERIFICATION_LOCKOUT");
  assert.equal(client.created, 1);
});

test("usage arrives immediately before finish", async () => {
  const { chunks, error } = await drain(adapter(fakeClient()));
  assert.equal(error, undefined);
  assert.deepEqual(
    chunks.map((chunk) => chunk.type).slice(-2),
    ["usage", "finish"],
  );
  assert.deepEqual(chunks.at(-1).reason, { kind: "stop" });
});

test("tool calls keep their ids and exact argument strings after verification", async () => {
  const client = fakeClient({
    stream: streamChunks({
      text: "",
      toolCalls: [
        { id: "call_a", name: "read", arguments: '{"path":"a.txt"}' },
        { id: "call_b", name: "write", arguments: '{"path":"b.txt","text":"x"}' },
      ],
      finishReason: "tool_calls",
    }),
  });

  const { chunks, error } = await drain(adapter(client));
  assert.equal(error, undefined);
  const calls = chunks
    .filter((chunk) => chunk.type === "block-end" && chunk.block.type === "tool-call")
    .map((chunk) => chunk.block);
  assert.deepEqual(calls, [
    { type: "tool-call", id: "call_a", name: "read", arguments: '{"path":"a.txt"}' },
    { type: "tool-call", id: "call_b", name: "write", arguments: '{"path":"b.txt","text":"x"}' },
  ]);
  assert.deepEqual(chunks.at(-1).reason, { kind: "tool-calls" });
});

test("a non-allowlisted model is refused before any provider call", async () => {
  const client = fakeClient();
  let clientsCreated = 0;
  const instance = new NearAiE2eeAdapter(
    { apiKeyEnv: "NEARAI_API_KEY" },
    {
      createClient: () => {
        clientsCreated += 1;
        return client;
      },
    },
  );

  const { chunks, error } = await drain(
    instance,
    options({ model: "deepseek/deepseek-v4.1-flash" }),
  );
  assert.equal(chunks.length, 0);
  assert.equal(error.code, "INVALID_MODEL");
  assert.equal(client.created, 0);
  assert.equal(clientsCreated, 0);
});

test("system, developer, assistant tool calls, and tool results translate in order", async () => {
  let body;
  const client = fakeClient({ onCreate: (requestBody) => (body = requestBody) });

  const request = options({
    system: "SYS",
    messages: [
      { role: "system", content: [{ type: "text", text: "leading" }] },
      { role: "developer", content: [{ type: "text", text: "DEV" }] },
      { role: "user", content: [{ type: "text", text: "U1" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "A1" },
          { type: "tool-call", id: "call_1", name: "read", arguments: '{"path":"x"}' },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: [{ type: "text", text: "RESULT" }] },
      { role: "user", content: [{ type: "text", text: "U2" }] },
    ],
    tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
  });

  const { error } = await drain(adapter(client), request);
  assert.equal(error, undefined);

  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[0].content, /SYS/);
  assert.match(body.messages[0].content, /leading/);
  assert.match(body.messages[0].content, /DEV/);
  assert.deepEqual(body.messages[1], { role: "user", content: "U1" });
  assert.equal(body.messages[2].role, "assistant");
  assert.deepEqual(body.messages[2].tool_calls[0], {
    id: "call_1",
    type: "function",
    function: { name: "read", arguments: '{"path":"x"}' },
  });
  assert.deepEqual(body.messages[3], {
    role: "tool",
    tool_call_id: "call_1",
    content: "RESULT",
  });
  assert.deepEqual(body.messages[4], { role: "user", content: "U2" });
  assert.equal(body.max_tokens, 2048);
  assert.equal(body.tools[0].function.name, "read");
});

test("reasoning efforts are advertised as none, low, high, max", async () => {
  const instance = adapter(fakeClient());
  const models = await instance.listModels("nearai-e2ee");
  assert.equal(models.length, 2);

  const resolved = await instance.resolveModel("nearai-e2ee", MODEL);
  assert.deepEqual(
    resolved.reasoning.efforts.map((effort) => effort.id),
    ["none", "low", "high", "max"],
  );
  assert.deepEqual(
    resolved.reasoning.efforts.map((effort) => effort.name),
    ["Off", "Low", "High", "Max"],
  );
});

test("the selected reasoning effort reaches the provider body", async () => {
  let body;
  await drain(
    adapter(fakeClient({ onCreate: (requestBody) => (body = requestBody) })),
    options({ reasoningEffort: "high" }),
  );
  assert.equal(body.reasoning_effort, "high");

  let offBody;
  await drain(
    adapter(fakeClient({ onCreate: (requestBody) => (offBody = requestBody) })),
    options({ reasoningEffort: "none" }),
  );
  assert.equal(offBody.reasoning_effort, "none");

  let defaultBody;
  await drain(
    adapter(fakeClient({ onCreate: (requestBody) => (defaultBody = requestBody) })),
    options(),
  );
  assert.equal("reasoning_effort" in defaultBody, false);
});

test("an unexpected reasoning effort is refused before any provider call", async () => {
  const client = fakeClient();
  const { chunks, error } = await drain(adapter(client), options({ reasoningEffort: "medium" }));
  assert.equal(chunks.length, 0);
  assert.equal(error.code, "UNSUPPORTED_OPTION");
  assert.equal(client.created, 0);
});

test("SDK HTTP and transport failures map to their real classes", async () => {
  const cases = [
    [401, "AUTH"],
    [403, "AUTH"],
    [429, "RATE_LIMIT"],
    [503, "SERVER"],
  ];
  for (const [status, code] of cases) {
    const error = new Error("http failure");
    error.failure = { code: "api.http_status", details: { resource: "chat", status } };
    const { error: mapped } = await drain(
      adapter(fakeClient({ onCreate: () => { throw error; } })),
    );
    assert.equal(mapped.code, code, `status ${status}`);
    assert.equal(mapped.failure.status, status);
  }

  const transport = new Error("network");
  transport.failure = {
    code: "api.transport_failed",
    details: { resource: "chat", reason: "request" },
  };
  const { error: mappedTransport } = await drain(
    adapter(fakeClient({ onCreate: () => { throw transport; } })),
  );
  assert.equal(mappedTransport.code, "TRANSPORT");
});

test("a stored credential is preferred over the launch environment", async () => {
  const previous = process.env.NEARAI_API_KEY;
  process.env.NEARAI_API_KEY = "env-key";

  let key;
  const client = fakeClient();
  const instance = new NearAiE2eeAdapter(
    { apiKeyEnv: "NEARAI_API_KEY" },
    {
      createClient: (options) => {
        key = options.apiKey;
        return client;
      },
      resolveStoredKey: async () => "stored-key",
    },
  );

  try {
    const { error } = await drain(instance);
    assert.equal(error, undefined);
    assert.equal(key, "stored-key");
  } finally {
    process.env.NEARAI_API_KEY = previous;
  }
});

test("a missing API key fails before a client is created", async () => {
  const previousPrimary = process.env.NEARAI_API_KEY;
  const previousFallback = process.env.NEAR_AI_API_KEY;
  delete process.env.NEARAI_API_KEY;
  delete process.env.NEAR_AI_API_KEY;

  let clientsCreated = 0;
  const instance = new NearAiE2eeAdapter(
    { apiKeyEnv: "NEARAI_API_KEY" },
    {
      createClient: () => {
        clientsCreated += 1;
        return fakeClient();
      },
    },
  );

  try {
    const { chunks, error } = await drain(instance);
    assert.equal(chunks.length, 0);
    assert.equal(error.code, "MISSING_API_KEY");
    assert.equal(clientsCreated, 0);
  } finally {
    process.env.NEARAI_API_KEY = previousPrimary;
    if (previousFallback !== undefined) process.env.NEAR_AI_API_KEY = previousFallback;
  }
});
