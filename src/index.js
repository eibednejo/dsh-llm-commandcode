/**
 * Register a {@link CommandCodeAdapter} for the `commandcode` provider route.
 *
 * Connection facts resolve per request instead of freezing at load: this
 * plugin layers its `cordis.yml` entry config under the optional
 * `llm-commandcode` user-settings section (`ctx.settings`) and resolves the
 * API key through the optional credential seam (`ctx.credentials`), then falls
 * back to the environment and to an auth file a Command Code CLI sign-in
 * already wrote. A changed base URL, catalog, or key therefore reaches the
 * very next request without a restart, while an in-flight stream keeps the
 * facts it started with.
 *
 * @module dsh-llm-commandcode
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  assertUsableApiKey,
  LlmError,
  resolveImageAttachmentAccess,
  resolveRetryPolicy,
  RetryPolicySchema,
} from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

import { CommandCodeAdapter } from './adapter.js'
import {
  DEFAULT_API_BASE,
  DEFAULT_API_KEY_ENV,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM,
  DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  DEFAULT_MAX_IMAGES_PER_REQUEST,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODELS,
  DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  parseDiscoveryPayload,
  PROVIDER,
  readAuthFileApiKey,
  resolveCliVersion,
  resolveModels,
} from './models.js'

export { PROVIDER, readAuthFileApiKey, resolveCliVersion } from './models.js'
export { CommandCodeAdapter } from './adapter.js'
export { serializeGenerateRequest } from './serialize.js'
export { translateGenerate } from './translate.js'

/** Module name the loader reports. */
export const name = 'llm-commandcode'

/** The one service this plugin requires; everything else is optional. */
export const inject = ['llm']

const NS = 'llm-commandcode'

/** How long one live catalog answer is reused before the endpoint is asked again. */
const MODEL_DISCOVERY_TTL_MS = 3_600_000
const MODEL_DISCOVERY_TIMEOUT_MS = 10_000

const MODEL_MODALITIES = ['text', 'image']
const REASONING_EFFORTS = ['off', 'low', 'high', 'max']

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(['text']),
  imagePixelBudget: z.union([z.number().step(1).min(1), z.const('low')]),
  imageMaxBytes: z.number().step(1).min(1),
})

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-commandcode` settings-section shape. Every field is optional:
 * a missing API key resolves per request (a request without any key fails with
 * `MISSING_CREDENTIAL`, not at plugin load), and omitted values take the
 * documented defaults.
 */
export const Config = z.object({
  /** Credential reference resolved per request; defaults to `COMMAND_CODE_API_KEY`. */
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  /** API root; the generate route appends `/alpha/generate`. */
  baseURL: z.string().default(DEFAULT_API_BASE),
  /** Working directory reported to the endpoint as request context. */
  workingDir: z.string(),
  /** Value sent as `x-command-code-version`; defaults to the installed CLI's own version. */
  cliVersion: z.string(),
  /** Default per-request output cap; a catalog model's own cap and explicit request values win. */
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  /** Capacity used for a model the catalog does not size. */
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  /** Effort selected while a session has picked none. */
  defaultReasoningEffort: z.union(REASONING_EFFORTS).default('high'),
  /** Maximum silence between two stream events. */
  streamIdleTimeoutMs: z.number().step(1).min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  /** Advisory catalog; defaults to the DeepSeek family on Command Code's Go plan. */
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  /** `auto` refreshes the advisory catalog from the endpoint; `static` never asks. */
  modelCatalog: z.union(['auto', 'static']).default('auto'),
  /** Send `x-cmd-zdr: 1`, asking the gateway for zero data retention. */
  zeroDataRetention: z.boolean().default(false),
  /** Default pixel budget for one request image; a catalog model's own budget wins. */
  requestImagePixelBudget: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET),
  /** Default encoded-byte target for one request image; a catalog model's own target wins. */
  requestImageMaxBytes: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_MAX_BYTES),
  /** Bound on accumulated base64 image payload in one request. */
  maxRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
  /** Maximum number of represented images in one request. */
  maxImagesPerRequest: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGES_PER_REQUEST),
  /** Raw-byte removal step applied once a request exceeds its image byte bound. */
  imageOffloadByteQuantum: z.number().step(1).min(1).default(DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM),
  /** Image-count removal step applied once a request exceeds its image count bound. */
  imageOffloadCountQuantum: z.number().step(1).min(1).default(DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM),
  /** Provider-owned retry policy; omission uses the normal defaults. */
  retryPolicy: RetryPolicySchema,
})

/**
 * Validate one snapshot of raw config into connection facts.
 *
 * Programmatic construction may bypass Schemastery normalization, so every
 * default and bound is re-judged here — for the composition entry at load
 * (fail loud) and for each settings snapshot at its first use.
 *
 * @param {object} config - Raw plugin config or a resolved settings snapshot.
 * @returns {object} Validated connection facts.
 */
export function resolveAdapterOptions(config = {}) {
  const baseURL = config.baseURL ?? DEFAULT_API_BASE
  if (typeof baseURL !== 'string' || baseURL.length === 0) {
    throw new Error('llm-commandcode: baseURL must be a non-empty string')
  }
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error('llm-commandcode: maxTokens must be a positive safe integer')
  }
  const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) {
    throw new Error('llm-commandcode: defaultContextWindow must be a positive integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
    throw new Error('llm-commandcode: streamIdleTimeoutMs must be a positive finite number')
  }
  const defaultReasoningEffort = config.defaultReasoningEffort ?? 'high'
  if (!REASONING_EFFORTS.includes(defaultReasoningEffort)) {
    throw new Error(`llm-commandcode: defaultReasoningEffort must be one of ${REASONING_EFFORTS.join(', ')}`)
  }
  const requestImagePixelBudget = config.requestImagePixelBudget ?? DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET
  if (!Number.isSafeInteger(requestImagePixelBudget) || requestImagePixelBudget <= 0) {
    throw new Error('llm-commandcode: requestImagePixelBudget must be a positive safe integer')
  }
  const requestImageMaxBytes = config.requestImageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES
  if (!Number.isSafeInteger(requestImageMaxBytes) || requestImageMaxBytes <= 0) {
    throw new Error('llm-commandcode: requestImageMaxBytes must be a positive safe integer')
  }
  const maxRequestImageBytes = config.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES
  if (!Number.isSafeInteger(maxRequestImageBytes) || maxRequestImageBytes <= 0) {
    throw new Error('llm-commandcode: maxRequestImageBytes must be a positive safe integer')
  }
  const maxImagesPerRequest = config.maxImagesPerRequest ?? DEFAULT_MAX_IMAGES_PER_REQUEST
  if (!Number.isSafeInteger(maxImagesPerRequest) || maxImagesPerRequest <= 0) {
    throw new Error('llm-commandcode: maxImagesPerRequest must be a positive safe integer')
  }
  const imageOffloadByteQuantum = config.imageOffloadByteQuantum ?? DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM
  if (!Number.isSafeInteger(imageOffloadByteQuantum) || imageOffloadByteQuantum <= 0) {
    throw new Error('llm-commandcode: imageOffloadByteQuantum must be a positive safe integer')
  }
  if (imageOffloadByteQuantum > maxRequestImageBytes) {
    throw new Error('llm-commandcode: imageOffloadByteQuantum must not exceed maxRequestImageBytes')
  }
  const imageOffloadCountQuantum = config.imageOffloadCountQuantum ?? DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM
  if (!Number.isSafeInteger(imageOffloadCountQuantum) || imageOffloadCountQuantum <= 0) {
    throw new Error('llm-commandcode: imageOffloadCountQuantum must be a positive safe integer')
  }
  if (imageOffloadCountQuantum > maxImagesPerRequest) {
    throw new Error('llm-commandcode: imageOffloadCountQuantum must not exceed maxImagesPerRequest')
  }
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL: baseURL.replace(/\/+$/g, ''),
    workingDir: config.workingDir ?? process.cwd(),
    cliVersion: config.cliVersion ?? resolveCliVersion(),
    maxTokens,
    defaultContextWindow,
    defaultReasoningEffort,
    streamIdleTimeoutMs,
    models: resolveModels(config.models),
    modelCatalog: config.modelCatalog ?? 'auto',
    zeroDataRetention: config.zeroDataRetention ?? false,
    requestImagePixelBudget,
    requestImageMaxBytes,
    maxRequestImageBytes,
    maxImagesPerRequest,
    imageOffloadByteQuantum,
    imageOffloadCountQuantum,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-commandcode: retryPolicy'),
  }
}

export function apply(ctx, config = {}) {
  let current = () => config
  let lastRaw
  let lastGood

  const options = () => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound: keep
      // serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-commandcode: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveApiKey = async () => {
    const ref = options().apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-commandcode', ref)
    }
    const ambient = process.env[String(ref)]
    if (typeof ambient === 'string' && ambient.length > 0) {
      return assertUsableApiKey(ambient, 'llm-commandcode', ref)
    }
    const stored = readAuthFileApiKey()
    if (stored !== undefined) return assertUsableApiKey(stored, 'llm-commandcode', ref)
    throw new LlmError(
      `llm-commandcode: no Command Code API key for provider route "${PROVIDER}"; run \`cmd login\`,`
      + ` set ${ref} in the launching environment, or store it through the credentials service`
      + ' (the web Models page writes it)',
      'MISSING_CREDENTIAL',
    )
  }

  /** Live catalog answers, keyed by endpoint and credential, reused for an hour. */
  const discoveryCache = new Map()
  const discoverModels = async () => {
    const resolved = options()
    if (resolved.modelCatalog !== 'auto') return undefined
    const apiKey = await resolveApiKey()
    const key = `${resolved.baseURL}\u0000${apiKey.slice(-8)}`
    const cached = discoveryCache.get(key)
    if (cached !== undefined && Date.now() - cached.at < MODEL_DISCOVERY_TTL_MS) return cached.models
    const response = await fetch(`${resolved.baseURL}/provider/v1/models`, {
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'accept': 'application/json',
      },
      signal: AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const models = parseDiscoveryPayload(await response.json())
    if (models === undefined) return undefined
    discoveryCache.set(key, { at: Date.now(), models })
    return models
  }

  const adapter = new CommandCodeAdapter({
    options,
    resolveApiKey,
    discoverModels,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
  })

  ctx.llm.registerAdapter([PROVIDER], adapter)
  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: 'Command Code',
      settingsNs: NS,
      settingsPath: [],
      declared: true,
    },
  ])

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source) => {
        current = source
      },
      onChange: () => {
        // Connection facts resolve per request, so nothing here is captured at
        // registration; the callback exists to surface a rejected snapshot.
        options()
      },
    })
  })
}
