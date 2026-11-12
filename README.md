# NEAR AI E2EE for DeepSeek Harness

A DeepSeek Harness provider plugin that routes one provider — `nearai-e2ee` —
through NEAR AI's verified, end-to-end-encrypted Chat Completions transport.

Before anything is sent it verifies the NEAR AI Gateway and the selected model's
TEE attestation, then encrypts the SDK-supported Chat fields to the attested
model key. Text and reasoning stream live; **tool calls are held back until the
response receipt verifies as `provider_tee`**. A failed verification rejects the
completion and locks the route until Harness restarts.

## Requirements

- DeepSeek Harness Desktop (the Web GUI) with the plugin manager
- A NEAR AI API key
- Node.js + npm **only** if you need to install dependencies or rebuild

## Install

1. In the **root of the project you open in Harness**, create a folder named
   `plugins`.
2. Download this repository and copy the **whole plugin folder** into it, so the
   layout is:

   ```
   plugins/
     dsh-llm-nearai-tee/
       package.json
       lib/index.js
       client.js
       ...
   ```

   The folder name itself does not matter, but the path you point the agent at
   must be the folder that **directly contains `package.json`**. The `name`
   inside `package.json` (`dsh-llm-nearai-tee`) is the plugin's identity and must
   not be changed.

3. Open a new chat in **Creator mode** and paste:

   > Install the DeepSeek Harness plugin in `./plugins/dsh-llm-nearai-tee` (use
   > your folder's name if you renamed it). Run `npm install --omit=dev` in that
   > folder, then call `plugin_manager` `install_bundle` with the folder's
   > absolute path and approve the request. Do not edit any files; report the
   > `application` value and any warnings.

4. Add your NEAR AI key (below).

5. **Quit and relaunch DeepSeek Harness.** The host plugin and its UI half load
   at startup; there is no live update.

6. Open the model menu and pick **NEAR AI — Verified Private TEE (E2EE)**.

### Add your API key

Easiest: **Settings → Models → NEAR AI** and paste the key.

Or write it once to the credential store:

```sh
mkdir -p ~/.dsh && cat > ~/.dsh/.credentials.yaml <<'YAML'
version: 1
refs:
  NEARAI_API_KEY: sk-your-key-here
YAML
chmod 600 ~/.dsh/.credentials.yaml
```

The plugin resolves `NEARAI_API_KEY`, then `NEAR_AI_API_KEY`, then the same
names in the environment that launched Harness. A stored value wins.

## Use

The model menu lists the two allowlisted models. The same menu has the effort
row:

| Picker row | Sent as `reasoning_effort` |
|---|---|
| Off | `none` |
| Low | `low` |
| High | `high` |
| Max | `max` |

NEAR AI maps its own `medium` onto `high`, so Medium is not offered — it would
send the same value as High. With no effort selected the field is omitted.

While the provider is selected, a shield badge appears in the composer dock
beside the activity and usage stats:

| Badge | Meaning |
|---|---|
| `E2EE · ready` | route selected, no turn yet |
| `E2EE · verifying…` | response streaming; tool calls still withheld |
| `E2EE · verified` | last completed turn carried a verified `provider_tee` receipt |
| `E2EE · not verified` | last turn ended in a verification failure |

The badge is hidden when the selected model is on another provider. It reads
only shipped client state, adds no transcript rows, and puts nothing into model
context.

## Supported models

| Model ID | |
|---|---|
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | default |
| `deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated` | optional variant |

The allowlist is **hardcoded on purpose**. The plugin does not discover models
from NEAR AI's catalog, because a catalog entry does not prove a model is served
with E2EE. Any other model id is refused before a request is sent — there is no
silent fallback to a non-E2EE route.

To add a model, confirm NEAR AI serves it with E2EE, then edit `MODELS` in
`src/index.ts` and rebuild. Or ask your agent in Creator mode:

> Add `<model-id>` to the `MODELS` allowlist in
> `plugins/dsh-llm-nearai-tee/src/index.ts`, run `npm run build`, then run
> `npm test` and report the result.

## Updating

Replace the plugin folder's **contents in place** at the same path with the new
version, then quit and relaunch Harness. Nothing else is required: the profile
links the folder, so `install_bundle` will say `already-installed` on an update.

If you moved the folder to a different path, remove the old install first:

```text
remove_bundle dsh-llm-nearai-tee
install_bundle <absolute path to the new folder>
```

then restart. Never keep two enabled copies — both would register the same
provider and the second would fail with `DUPLICATE_ADAPTER`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Provider not in the model menu | Confirm the install reported `application: applied`, then quit and relaunch |
| `already-installed` | Expected for an in-place update. On a new machine it means an older copy is linked: `remove_bundle` first |
| `DUPLICATE_ADAPTER` | Two copies are enabled — remove one |
| `MISSING_API_KEY` | Add a key to the credential store or environment, then retry |
| Badge never appears | Make sure the selected model is on this provider; reload the page or restart |
| `VERIFICATION_LOCKOUT` | A response failed verification by design. Restart Harness to clear it |

## Security

- E2EE is hardcoded. No configuration can disable encryption or attestation.
- Tool calls are never released before a `provider_tee` receipt verifies.
- Text and reasoning are shown before verification — that is a deliberate
  trade-off so streaming feels live. Only tool calls wait.
- A failed verification locks the route until Harness restarts.
- The plugin does **not** pin deployment measurements against a local allowlist;
  it trusts NEAR AI's attestation chain. See [SECURITY.md](SECURITY.md) for the
  exact verified / not-verified boundary.

## Repository layout

```
package.json          plugin manifest (host + client halves)
cordis.patch.yml      Loader patch that inserts the provider row
lib/index.js          committed host build (no build needed to run)
src/index.ts          host source
client.js             browser half: the composer-dock badge
locale/en.json        display metadata for the plugin list
icon.svg              plugin icon
test/adapter.test.mjs node:test suite
SECURITY.md           design and security details
```

Developer notes: `npm run build` compiles `src/` → `lib/`;
`node --test test/adapter.test.mjs` runs the suite.
