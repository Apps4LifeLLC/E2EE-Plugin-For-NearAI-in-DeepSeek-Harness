# dsh-llm-nearai-tee

A small DeepSeek Harness provider plugin that routes **one** provider route,
`nearai-e2ee`, through NEAR AI's verified, end-to-end-encrypted Chat
Completions transport.

It is intentionally not a proxy: the adapter runs in the Harness Host process
and calls the official `@nearai/inference-sdk` directly.

## What it does

- Verifies the NEAR AI Gateway and the selected model's TEE attestation before
  sending the prompt. `e2ee: true` is hardcoded and cannot be turned off.
- Encrypts the SDK-supported Chat fields to the verified model key (user,
  system/developer, assistant, reasoning, tool calls/arguments, tool results).
- Streams text and reasoning deltas live.
- Buffers tool calls and holds them back until `verifyResponse(completion.id)`
  succeeds and the receipt says `provider_tee`.
- Exposes reasoning-effort choices (Off, Low, High, Max) for the model picker.
- Adds a verification badge to the composer dock beside the activity and usage
  pills, whenever the session's selected model is on this route.
- On a verification failure, rejects the completion and latches a profile-wide
  `VERIFICATION_LOCKOUT`: later requests fail until Harness is restarted or the
  plugin is reloaded.
- Refuses any model outside the allowlist, unsupported options, and missing
  keys. There is no fallback route.

## Allowed models

| Model ID | Notes |
|---|---|
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | Default |
| `deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated` | Optional variant |

To restrict the route to one model, remove the other entry from `MODELS` in
`src/index.ts` and rebuild.

## Reasoning effort

The picker offers one row per distinct wire value:

| Picker row | Sent as `reasoning_effort` |
|---|---|
| Off | `none` |
| Low | `low` |
| High | `high` |
| Max | `max` |

NEAR AI maps its own `medium` onto `high`, so Medium is not offered as a fifth
row — it would send the same value as High. The selection is per session and
applies to the next request; a running step keeps the effort it started with.
With no selection the field is omitted and the provider default applies.

## API key: Harness credential store (recommended)

The plugin resolves, in order:

1. the `NEARAI_API_KEY` credential reference,
2. the `NEAR_AI_API_KEY` credential reference (the existing profile convention),
3. the same names in the launch environment.

The local store is a YAML file at `~/.dsh/.credentials.yaml` (or
`$DSH_HOME/.credentials.yaml`) by default. It is created owner-only and refuses
to load if another user can read it.

Edit it directly:

```yaml
version: 1

refs:
  NEARAI_API_KEY: sk-…
```

Then:

```sh
chmod 600 ~/.dsh/.credentials.yaml
```

The store watches the file and reloads automatically; no restart is needed for
a key change. A stored value takes precedence over the environment. If you
prefer not to edit the file, enter the key in the Models/credentials UI for the
NEAR AI provider; it writes the same reference space.

Security note: the file is plaintext YAML with owner-only permissions. Any
process running as your OS user can read it. It is not the macOS Keychain. It
is still better than a session-wide `launchctl` variable because it is
persistent, scoped to Harness, and not visible to every GUI app.

## Build

```sh
npm run build
```

The committed runtime entry is `lib/index.js`. Rebuild after changing
`src/index.ts`. The browser half is the plain-JavaScript `client.js`, which
needs no build step.

## Tests

```sh
node --test test/adapter.test.mjs
```

The tests use a fake SDK client and assert, among other things, that text may
flow before verification but **no** tool-call chunk is released before
`provider_tee` verification, that a Gateway receipt is rejected and latches a
lockout, that a failed signature is not retried, and that tool-call IDs and
argument strings survive translation.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxOutputTokens` | `2048` | Default cap when the caller names none |
| `maxConcurrentRequests` | `25` | In-flight request limit |
| `requestTimeoutMs` | `300000` | Whole-request timeout |
| `attestationCacheTimeToLiveMs` | `3600000` | SDK attestation cache; `0` verifies every request |
| `responseCacheTimeToLiveMs` | `3600000` | Retention of response bytes for `verifyResponse` |
| `contextWindow` | `1000000` | Advisory context metadata for Harness |
| `apiKeyEnv` | `NEARAI_API_KEY` | Preferred credential reference/env name |

No configuration can disable E2EE, model attestation, or response
verification.

## Selecting it in Harness

After the bundle is installed and enabled, the model picker shows the provider
**NEAR AI — Verified Private TEE (E2EE)** under the route `nearai-e2ee`. Select
one of its models, or set it as the default model, then choose an effort from
the same menu.

## E2EE badge

The composer dock shows a shield badge beside the activity and usage pills
whenever the session's selected model is on this route:

| Badge | Meaning |
|---|---|
| `E2EE · ready` | the route is selected; no turn has run yet |
| `E2EE · verifying…` | a response is streaming; tool calls are still withheld |
| `E2EE · verified` | the last completed turn carried a verified `provider_tee` receipt |
| `E2EE · not verified` | the last turn ended in a verification failure |

The badge reads only shipped client state — the session's model-selection
projection, its running flag, and the kind of its last chat node. It adds no
transcript rows, so nothing enters model context, and it is a status display,
not cryptographic proof: the proof is the `provider_tee` check in the adapter.

The pre-existing `near-ai` route (pi-ai) is a separate, non-E2EE route. It is
not changed by this plugin. Do not select it if you want E2EE.

## Verified vs. not verified

**Verified by the SDK on each request**

- Gateway TEE attestation and TLS identity (Node entry point).
- Model deployment TEE attestation for the selected model.
- E2EE model-key binding to that attestation.
- Authenticated decryption of supported response fields.
- Response receipt bound to the exact encrypted request/response bytes.
- Receipt signer equals the attested model signer (`provider_tee`).

**Not verified by this plugin**

- A local allowlist of approved deployment measurements or image digests. The
  SDK verifies attestation but does not compare measurements to an allowlist
  unless a `deploymentPolicy` is supplied. This plugin does not supply one.
- HTTP metadata, headers, authentication metadata, URL/query parameters, or
  Chat fields outside the SDK's E2EE table. Those may remain visible.
- Data after decryption inside the Harness process. Prompt and completion
  plaintext necessarily exists there, and is subject to any logging performed
  elsewhere in Harness.
- Text shown live before `verifyResponse` succeeds. Tool calls are held back,
  but the operator explicitly chose live text.

## Stopping requests

Disable or remove this bundle in the Harness plugin manager, or change the
selected model away from `nearai-e2ee`. There is no paid-request retry and no
automatic fallback.

## Updating the SDK

The plugin pins `@nearai/inference-sdk` to `0.2.1`. To update:

1. Review the new SDK's `InferenceClient`, `verifyResponse`, and E2EE/attestation
   docs.
2. Update the exact version in `package.json`.
3. Rebuild and rerun `node --test test/adapter.test.mjs`.
4. Re-run one minimal live verification before relying on it.
