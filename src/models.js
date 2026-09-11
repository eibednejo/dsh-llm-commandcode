/**
 * Command Code connection facts: the provider identity, the advisory model
 * catalog, credential discovery, and the CLI-version header fact the endpoint
 * gates on.
 *
 * The catalog is advisory only — a request naming a model this file does not
 * list is still sent, exactly as the LLM seam requires. Live discovery through
 * the plan-gated `GET /provider/v1/models` listing refreshes it when a key is
 * available, and the static catalog is the offline fallback.
 *
 * @module dsh-llm-commandcode/models
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The single provider route this plugin owns. */
export const PROVIDER = 'commandcode'

/** Command Code API root; the generate route appends `/alpha/generate`. */
export const DEFAULT_API_BASE = 'https://api.commandcode.ai'

/** Combined request/response capacity advertised for every catalog model. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000

/** Per-request output cap used when a request names none. */
export const DEFAULT_MAX_TOKENS = 64_000

/** Total-pixel budget for one deterministic request image. */
export const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 640_000

/** Total-pixel budget matching a provider's low-detail image input. */
export const DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET = 512 * 512

/** Encoded-byte target for one request image; the smallest quality-ladder output is kept when none fits. */
export const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024

/** Bound on accumulated base64 image payload in one request. */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024

/** Maximum number of represented images in one request. */
export const DEFAULT_MAX_IMAGES_PER_REQUEST = 600

/** Raw-byte removal step applied once a request exceeds its image byte bound. */
export const DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM = 10 * 1024 * 1024

/** Image-count removal step applied once a request exceeds its image count bound. */
export const DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM = 20

/** Idle bound while one stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Credential reference resolved through the harness credential seam. */
export const DEFAULT_API_KEY_ENV = 'COMMAND_CODE_API_KEY'

/**
 * Declared when neither the installed `command-code` package nor the
 * environment names a version. The endpoint rejects clients below its own
 * minimum (`upgrade_required`), so this is a floor, not a claim of currency.
 */
export const FALLBACK_CLI_VERSION = '1.53.0'

/**
 * One advisory catalog entry.
 *
 * @typedef {object} CatalogModel
 * @property {string} id - Wire model id accepted by `params.model`.
 * @property {string} [name] - Selector label; defaults to the id.
 * @property {string} [description] - Selector detail.
 * @property {number} [contextWindow] - Combined request/response capacity.
 * @property {number} [maxTokens] - Per-request output cap for this model.
 * @property {readonly ('text'|'image')[]} [inputModalities] - Accepted input; omission is text-only.
 */

/**
 * Accepted input modalities per model, as the `cmd` CLI declares them.
 *
 * A model absent from this table is treated as text-only. That is the safe
 * direction: the harness replaces an image with deterministic text for a
 * text-only route, while a falsely declared image capability would persist
 * input the endpoint may refuse on every later turn of the session.
 *
 * `deepseek/deepseek-v4.1-flash` is listed on direct evidence: the published
 * 1.44 CLI snapshot omits it, but the endpoint accepts image input for it and
 * the model reads the image correctly.
 */
export const MODEL_INPUT_MODALITIES = Object.freeze({
  'claude-fable-5': ['text', 'image'],
  'claude-fable-5-1': ['text', 'image'],
  'claude-haiku-4-5-20251001': ['text', 'image'],
  'claude-opus-4-7': ['text', 'image'],
  'claude-opus-4-8': ['text', 'image'],
  'claude-opus-5': ['text', 'image'],
  'claude-sonnet-4-6': ['text', 'image'],
  'claude-sonnet-5': ['text', 'image'],
  'deepseek/deepseek-v4-flash-vision-exp': ['text', 'image'],
  'deepseek/deepseek-v4.1-flash': ['text', 'image'],
  'google/gemini-3.1-flash-lite': ['text', 'image'],
  'google/gemini-3.5-flash': ['text', 'image'],
  'google/gemini-3.5-flash-lite': ['text', 'image'],
  'google/gemini-3.6-flash': ['text', 'image'],
  'google/gemini-3.7-flash': ['text', 'image'],
  'google/gemini-3.8-flash': ['text', 'image'],
  'gpt-5.3-codex': ['text', 'image'],
  'gpt-5.4': ['text', 'image'],
  'gpt-5.4-mini': ['text', 'image'],
  'gpt-5.5': ['text', 'image'],
  'gpt-5.6-luna': ['text', 'image'],
  'gpt-5.6-sol': ['text', 'image'],
  'gpt-5.6-terra': ['text', 'image'],
  'meta/muse-spark-1.1': ['text', 'image'],
  'meta/muse-spark-1.2': ['text', 'image'],
  'meta/muse-spark-1.2-contributor': ['text', 'image'],
  'meta/muse-spark-1.3': ['text', 'image'],
  'meta/muse-spark-1.3-contributor': ['text', 'image'],
  'MiniMaxAI/MiniMax-M3': ['text', 'image'],
  'moonshotai/Kimi-K2.5': ['text', 'image'],
  'moonshotai/Kimi-K2.6': ['text', 'image'],
  'moonshotai/Kimi-K2.7-Code': ['text', 'image'],
  'moonshotai/Kimi-K2.7-Code-Highspeed': ['text', 'image'],
  'moonshotai/Kimi-K3': ['text', 'image'],
  'Qwen/Qwen3.6-Plus': ['text', 'image'],
  'Qwen/Qwen3.7-Flash': ['text', 'image'],
  'Qwen/Qwen3.7-Plus': ['text', 'image'],
  'Qwen/Qwen3.8-27B': ['text', 'image'],
  'Qwen/Qwen3.8-Flash': ['text', 'image'],
  'Qwen/Qwen3.8-Max': ['text', 'image'],
  'Qwen/Qwen3.8-Max-0902': ['text', 'image'],
})

/** Modalities declared for a model the table does not describe. */
export const TEXT_ONLY_MODALITIES = Object.freeze(['text'])

/**
 * Accepted input modalities for one model id.
 *
 * @param {string} modelId - Wire model id.
 * @returns {readonly ('text'|'image')[]} Declared modalities.
 */
export function inputModalitiesForModel(modelId) {
  return MODEL_INPUT_MODALITIES[modelId] ?? TEXT_ONLY_MODALITIES
}

/**
 * Resolve the deterministic request-image policy for one catalog model.
 *
 * A model's own budgets win; anything it leaves unset falls back to the
 * route-level defaults, so one deployment can widen every model at once
 * without restating each catalog entry.
 *
 * @param {CatalogModel} model - Catalog entry, with optional per-model overrides.
 * @param {{requestImagePixelBudget: number, requestImageMaxBytes: number}} [defaults] - Route-level budgets.
 * @returns {{maxPixels: number, maxBytes: number}} Policy for the attachment service.
 */
export function resolveImagePolicy(model, defaults = {}) {
  const fallbackPixels = defaults.requestImagePixelBudget ?? DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET
  const fallbackBytes = defaults.requestImageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES
  return {
    maxPixels: model.imagePixelBudget === 'low'
      ? DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET
      : model.imagePixelBudget ?? fallbackPixels,
    maxBytes: model.imageMaxBytes ?? fallbackBytes,
  }
}

/** Static fallback catalog: the DeepSeek family on Command Code's Go plan. */
export const DEFAULT_MODELS = Object.freeze([
  {
    id: 'deepseek/deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    description: 'V4.1 hybrid-attention reasoning with vision; the balanced default.',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    inputModalities: ['text', 'image'],
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    description: 'Fast hybrid-attention reasoning; suited to routine or parallel tasks.',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    description: 'Stronger long-context reasoning; suited to complex or quality-critical tasks.',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  },
  {
    id: 'deepseek/deepseek-v4-flash-fast',
    name: 'DeepSeek V4 Flash Fast',
    description: 'Low-latency V4 Flash deployment.',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  },
  {
    id: 'deepseek/deepseek-v4-flash-vision-exp',
    name: 'DeepSeek V4 Flash Vision (exp)',
    description: 'Fast hybrid-attention reasoning with vision input.',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    inputModalities: ['text', 'image'],
  },
])

/** Credential-bearing auth files the host may already have written, in precedence order. */
export const AUTH_FILE_CANDIDATES = Object.freeze([
  ['.commandcode', 'auth.json'],
  ['.pi', 'agent', 'auth.json'],
  ['.omp', 'agent', 'auth.json'],
])

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Read the raw key out of one parsed auth document, tolerating both host shapes. */
function apiKeyFromDocument(document) {
  if (!isRecord(document)) return undefined
  const direct = nonEmptyString(document.apiKey)
  if (direct !== undefined) return direct
  const directLegacy = nonEmptyString(document.commandcode)
  if (directLegacy !== undefined) return directLegacy
  for (const field of ['commandcode', 'command-code']) {
    const record = document[field]
    if (!isRecord(record)) continue
    const key = nonEmptyString(record.apiKey)
      ?? nonEmptyString(record.key)
      ?? nonEmptyString(record.access)
    if (key !== undefined) return key
  }
  return undefined
}

/**
 * Discover an API key already stored on this machine.
 *
 * This exists so a dsh plugin can take over a host whose Command Code CLI (or
 * pi, or OMP) has already signed in; it never writes and never logs the key.
 *
 * @param {string} [home] - Home directory to search; defaults to the real one.
 * @returns {string | undefined} The first usable raw key, when any.
 */
export function readAuthFileApiKey(home = homedir()) {
  for (const segments of AUTH_FILE_CANDIDATES) {
    const path = join(home, ...segments)
    try {
      if (!existsSync(path)) continue
      const document = JSON.parse(readFileSync(path, 'utf8'))
      const key = apiKeyFromDocument(document)
      if (key !== undefined) return key
    } catch {
      // An unreadable or malformed auth file is not an error: another
      // candidate, the credential seam, or the environment may still answer.
    }
  }
  return undefined
}

/**
 * Resolve the CLI version reported in the `x-command-code-version` header.
 *
 * The endpoint refuses clients below its advertised minimum, so the installed
 * CLI's own version is preferred over a constant that ages out.
 *
 * @param {NodeJS.ProcessEnv} [env] - Environment to consult for an override.
 * @returns {string} A version string to send on the wire.
 */
export function resolveCliVersion(env = process.env) {
  const override = nonEmptyString(env.COMMAND_CODE_CLI_VERSION)
  if (override !== undefined) return override
  const packageRoots = [
    join(homedir(), '.local', 'lib', 'node_modules', 'command-code', 'package.json'),
    join(homedir(), '.npm-global', 'lib', 'node_modules', 'command-code', 'package.json'),
    '/usr/local/lib/node_modules/command-code/package.json',
    '/usr/lib/node_modules/command-code/package.json',
  ]
  for (const path of packageRoots) {
    try {
      if (!existsSync(path)) continue
      const version = nonEmptyString(JSON.parse(readFileSync(path, 'utf8')).version)
      if (version !== undefined) return version
    } catch {
      // Fall through to the next candidate.
    }
  }
  return FALLBACK_CLI_VERSION
}

/**
 * Validate and detach the advisory catalog, rejecting a configuration whose
 * entries could not round-trip onto the wire.
 *
 * @param {readonly CatalogModel[] | undefined} models - Configured catalog, or the default.
 * @returns {CatalogModel[]} Detached catalog entries.
 */
export function resolveModels(models) {
  const source = models ?? DEFAULT_MODELS
  const seen = new Set()
  return source.map((model) => {
    if (typeof model.id !== 'string' || model.id.length === 0) {
      throw new Error('llm-commandcode: catalog model ids must be non-empty strings')
    }
    if (seen.has(model.id)) throw new Error(`llm-commandcode: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(`llm-commandcode: catalog model "${model.id}" contextWindow must be a positive integer`)
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(`llm-commandcode: catalog model "${model.id}" maxTokens must be a positive integer`)
    }
    const inputModalities = model.inputModalities ?? ['text']
    if (inputModalities.length === 0) {
      throw new Error(`llm-commandcode: catalog model "${model.id}" inputModalities must not be empty`)
    }
    if (inputModalities.some(modality => modality !== 'text' && modality !== 'image')) {
      throw new Error(`llm-commandcode: catalog model "${model.id}" inputModalities must be "text" or "image"`)
    }
    if (new Set(inputModalities).size !== inputModalities.length) {
      throw new Error(`llm-commandcode: catalog model "${model.id}" inputModalities must not repeat`)
    }
    const hasImage = inputModalities.includes('image')
    if (!hasImage && (model.imagePixelBudget !== undefined || model.imageMaxBytes !== undefined)) {
      throw new Error(
        `llm-commandcode: text-only catalog model "${model.id}" cannot declare image request limits`,
      )
    }
    if (model.imagePixelBudget !== undefined
      && model.imagePixelBudget !== 'low'
      && (!Number.isSafeInteger(model.imagePixelBudget) || model.imagePixelBudget <= 0)) {
      throw new Error(
        `llm-commandcode: catalog model "${model.id}" imagePixelBudget must be "low" or a positive safe integer`,
      )
    }
    if (model.imageMaxBytes !== undefined
      && (!Number.isSafeInteger(model.imageMaxBytes) || model.imageMaxBytes <= 0)) {
      throw new Error(`llm-commandcode: catalog model "${model.id}" imageMaxBytes must be a positive safe integer`)
    }
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      inputModalities: [...inputModalities],
      ...model.imagePixelBudget === undefined ? {} : { imagePixelBudget: model.imagePixelBudget },
      ...model.imageMaxBytes === undefined ? {} : { imageMaxBytes: model.imageMaxBytes },
    }
  })
}

/**
 * Normalize one entry of the plan-gated `GET /provider/v1/models` listing into
 * the advisory catalog shape. The listing is OpenAI-compatible: an object with
 * a `data` array, each entry carrying at least an id.
 *
 * The listing discloses no modalities, so each discovered model's declared
 * input comes from {@link inputModalitiesForModel} — a discovered id the table
 * does not describe stays text-only, and the harness substitutes text for any
 * image rather than sending one the endpoint may refuse.
 *
 * @param {unknown} payload - Parsed response body.
 * @returns {CatalogModel[] | undefined} Detached entries, or undefined when the listing is unrecognized.
 */
export function parseDiscoveryPayload(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return undefined
  const models = []
  for (const entry of payload.data) {
    if (!isRecord(entry)) continue
    const id = nonEmptyString(entry.id)
    if (id === undefined) continue
    const name = nonEmptyString(entry.name)
    const contextWindow = Number.isInteger(entry.context_length) && entry.context_length > 0
      ? entry.context_length
      : undefined
    const inputModalities = inputModalitiesForModel(id)
    models.push({
      id,
      ...name === undefined ? {} : { name },
      ...contextWindow === undefined ? {} : { contextWindow },
      inputModalities: [...inputModalities],
    })
  }
  return models.length === 0 ? undefined : models
}

/**
 * Build the project slug Command Code's own CLI sends, so gateway-side project
 * attribution matches a `cmd`-driven session.
 *
 * @param {string} pathName - Absolute working directory.
 * @returns {string} A lowercase hyphenated slug.
 */
export function projectSlugFromPath(pathName) {
  const slug = pathName
    .toLowerCase()
    .replace(/^[a-z]:/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'project'
}
