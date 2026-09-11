# dsh-llm-commandcode

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) LLM
adapter that routes model calls through [Command Code](https://commandcode.ai),
so a **Command Code Go plan** can serve DeepSeek — and Claude, GPT, Kimi, GLM,
Qwen, MiniMax — to the harness, including image input.

```text
pi ──────────► pi-commandcode-provider ──┐
dsh ─────────► dsh-llm-commandcode ──────┼──► api.commandcode.ai ──► model
cmd ─────────► (native) ─────────────────┘
```

## Why this exists

Command Code's plan tiers gate which API surface an account may reach:

| Plan | `POST /provider/v1/chat/completions` | `POST /alpha/generate` | `GET /provider/v1/models` |
|---|---|---|---|
| Go | **403 `upgrade_required`** | allowed | allowed |
| Provider and above | allowed | allowed | allowed |

`/alpha/generate` is the endpoint the `cmd` CLI itself drives, and it is the one
a Go plan can reach. This adapter speaks it: the harness gets a normal
`LlmAdapter` route, and the requests underneath are the CLI's own transport.
The pi extension `pi-commandcode-provider` does the same thing with a transport
router; this plugin is the dsh equivalent, written against the harness adapter
seam rather than a compat shim.

If your account is on Provider plan or higher, you do not need this plugin —
`dsh-llm-pi-ai` can reach the documented Provider API with plain configuration.

## Install

From a checkout of this directory:

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-llm-commandcode
```

Then add two rows to that profile's `cordis.patch.yml`
(`$DSH_HOME/profiles/<profile>/cordis.patch.yml`):

```yaml
# Aim the harness at the new route.
- id: agent-default-model
  config:
    provider: commandcode
    model: deepseek/deepseek-v4.1-flash
    reasoningEffort: high

# Mount the adapter.
- insert:
    - id: llm-commandcode
      name: 'dsh-llm-commandcode'
      config:
        baseURL: https://api.commandcode.ai
        apiKeyEnv: COMMAND_CODE_API_KEY
        modelCatalog: auto
        defaultReasoningEffort: high
```

Restart `dsh web`. The model picker then shows a **Command Code** group beside
the built-in DeepSeek one.

## Credentials

The key resolves per request, first match wins:

1. the harness credentials service (`~/.dsh/.credentials.yaml`, written by the
   Models page in the Web UI)
2. the environment variable named by `apiKeyEnv`
3. `~/.commandcode/auth.json` — what `cmd login` writes — then pi's and OMP's
   auth files

Nothing in the configuration stores the secret, and a request without any key
fails with `MISSING_CREDENTIAL` rather than at plugin load, so the rest of the
harness keeps working.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `COMMAND_CODE_API_KEY` | Credential reference resolved per request |
| `baseURL` | `https://api.commandcode.ai` | API root; `/alpha/generate` is appended |
| `workingDir` | process working directory | Reported to the endpoint as request context |
| `cliVersion` | installed `command-code` version, else `1.53.0` | Sent as `x-command-code-version`, which the endpoint gates on |
| `maxTokens` | `64000` | Default output cap; a catalog model's own cap and an explicit request value win |
| `defaultContextWindow` | `1000000` | Capacity for a model the catalog does not size |
| `defaultReasoningEffort` | `high` | Effort used while a session has picked none |
| `streamIdleTimeoutMs` | `300000` | Maximum silence between two stream events |
| `models` | the five DeepSeek models | Static advisory catalog, used when discovery is off or unreachable |
| `modelCatalog` | `auto` | `auto` refreshes from the endpoint (cached an hour); `static` never asks |
| `zeroDataRetention` | `false` | Send `x-cmd-zdr: 1`, asking the gateway for zero retention |
| `requestImagePixelBudget` | `640000` | Route default pixel budget per request image; a catalog model's own budget wins |
| `requestImageMaxBytes` | `1048576` | Route default encoded-byte target per request image; a catalog model's own target wins |
| `maxRequestImageBytes` | `20971520` | Bound on accumulated base64 image payload in one request |
| `maxImagesPerRequest` | `600` | Maximum represented images in one request |
| `imageOffloadByteQuantum` | `10485760` | Raw-byte removal step once the payload bound is exceeded |
| `imageOffloadCountQuantum` | `20` | Image-count removal step once the count bound is exceeded |
| `retryPolicy` | normal, five retries | Provider-owned retry policy |

A per-model override goes on the catalog entry itself:

```yaml
- id: llm-commandcode
  name: 'dsh-llm-commandcode'
  config:
    models:
      - id: deepseek/deepseek-v4.1-flash
        inputModalities: [text, image]
        imagePixelBudget: 1048576 # a larger per-image budget than the route default
        imageMaxBytes: 2097152
```

## Image input

An image is transported as an inline base64 data URL part. Each image is
preceded by a short identity line the model can refer to, which also carries a
read-only path when the harness can map the attachment to one, so the model's
file tools can open the normalized copy.

Whether a model accepts images comes from `MODEL_INPUT_MODALITIES` in
[`src/models.js`](src/models.js), which mirrors the `cmd` CLI's own catalog.
A model the table does not describe is treated as **text-only** — the harness
then substitutes deterministic text for each image instead of sending one the
endpoint may reject on every later turn of the session. That is why an
uncatalogued model still works with an image attached rather than failing.

Images from a tool result cannot ride in its text-only `role: 'tool'` message,
so they follow it in their own user turn — the same shape Command Code's own CLI
sends.

## What is and is not supported

Working, and verified against the live endpoint:

- streaming text and reasoning (`reasoning_content` equivalents)
- tool calls, including multi-turn call/result round trips
- image input on models the catalog declares image-capable
- cache-aware token accounting reported as disjoint counts
- the reasoning-effort menu (`off`, `low`, `high`, `max`)
- per-request credential and endpoint re-resolution

Deliberate limits, declared rather than hidden:

- **Stop sequences are not sent.** The generate route has no verified field for
  them, and inventing one risks a refused request.
- **Images are sent inline, not uploaded.** One request is bounded by
  `maxRequestImageBytes`; a history that exceeds it has its oldest image
  occurrences replaced by deterministic placeholder text rather than failing.
- **The model catalog is advisory.** Discovery reads the plan-gated
  `GET /provider/v1/models` listing and falls back to the static catalog; any
  model id can still be requested directly, as the seam requires.

## Caveat

`/alpha/generate` is Command Code's internal CLI endpoint, not its documented
Provider API, and the plan gating above is a business decision that can change.
This adapter is the same workaround the pi extension uses; treat it as such. If
you need a supported contract, Provider plan plus `dsh-llm-pi-ai` against
`/provider/v1` is the intended path.

Not affiliated with or endorsed by Command Code or DeepSeek.

## Test

```sh
npm test                  # 33 offline checks, no network
npm run test:live         # drives the real endpoint, needs a Command Code key
node tests/live-adapter.mjs deepseek/deepseek-v4-pro
```

The offline suite covers request serialization, the image path, stream
translation, and configuration resolution. The live script drives the real
endpoint through this plugin's own serialize and translate path with no harness
runtime, and prints each turn's blocks, usage, and finish reason.

The `pretest` hook runs [`scripts/link-dsh-deps.mjs`](scripts/link-dsh-deps.mjs),
which links the `@deepseek-ai/*` packages this plugin imports out of your dsh
installation. That is what makes the suite runnable from a bare clone; a plugin
installed into a profile through `dsh plugin add` needs none of it, because the
profile's loader supplies the resolution.
