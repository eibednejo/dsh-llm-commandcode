/**
 * `CommandCodeAdapter`: a `LlmAdapter` that streams Command Code's generate
 * endpoint into harness chunks.
 *
 * The adapter is transport-only. Connection facts arrive through a thunk the
 * registering plugin owns — resolved once per operation, so an in-flight
 * stream never observes a configuration change and the next call re-resolves —
 * and the bearer token arrives through a per-request resolver.
 *
 * Image input is transported as inline base64 data URLs. A model declares
 * `image` only when the catalog does; for a model that does not, the harness
 * substitutes deterministic text for each image before this adapter is reached,
 * and the adapter refuses an undeclared image as a safety net.
 *
 * One deliberate limit is declared rather than hidden: stop sequences are not
 * sent. The generate route has no verified field for them, and inventing one
 * would risk a refused request.
 *
 * @module dsh-llm-commandcode/adapter
 */

import { randomUUID } from 'node:crypto'

import {
  attributionHeaders,
  LlmAdapter,
  LlmError,
  offloadedImageText,
  offloadRequestImagesWithPolicy,
  ProviderRequestId,
  ReasoningEffortId,
  requestImageHandleText,
} from '@deepseek-ai/dsh-llm'

import {
  DEFAULT_MAX_IMAGES_PER_REQUEST,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM,
  DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  projectSlugFromPath,
  resolveImagePolicy,
} from './models.js'
import { collectImageRefs, contentHasImage, serializeGenerateRequest } from './serialize.js'
import { readEvents, translateGenerate } from './translate.js'

/** Stable code for the per-read idle bound. */
export const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

const isUuid = value =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

const REASONING_EFFORTS = [
  {
    id: ReasoningEffortId('off'),
    name: 'Off',
    description: 'Do not think; send no reasoning effort.',
  },
  {
    id: ReasoningEffortId('low'),
    name: 'Low',
    description: 'Prefer for routine or latency-sensitive tasks.',
  },
  {
    id: ReasoningEffortId('high'),
    name: 'High',
    description: 'The default balance for most tasks.',
  },
  {
    id: ReasoningEffortId('max'),
    name: 'Max',
    description: 'Reserve for the hardest quality-first tasks.',
  },
]

/**
 * Map a non-2xx response to a stable harness error code.
 *
 * @param {number} status - HTTP status of the refused response.
 * @param {string} detail - Provider-supplied error text, when any.
 * @returns {string} The normalized code.
 */
export function httpErrorCode(status, detail) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 413) return 'INVALID_REQUEST'
  if (status === 429) return /quota|credit|insufficient|exceeded/iu.test(detail) ? 'QUOTA' : 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/** Read one provider error body into its message and code, tolerating both shapes. */
function providerErrorFacts(payload) {
  if (typeof payload !== 'object' || payload === null) return {}
  const error = typeof payload.error === 'object' && payload.error !== null ? payload.error : payload
  return {
    message: typeof error.message === 'string' ? error.message : undefined,
    code: typeof error.code === 'string' ? error.code : undefined,
  }
}

/** Honor `Retry-After` in either delta-seconds or HTTP-date form. */
function providerRetryAfterMs(value) {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

/**
 * Race an event source against a per-read idle bound.
 *
 * The bound applies to one outstanding read, not to the whole call: a stream
 * that keeps producing is never cut off, while a provider that goes silent
 * fails with `TIMEOUT` instead of hanging a session forever.
 *
 * @param {AsyncIterable<object>} source - Events to relay.
 * @param {number} idleTimeoutMs - Maximum silence between two events.
 * @param {() => void} onIdle - Invoked once when the bound trips.
 * @returns {AsyncGenerator<object>} The same events, idle-bounded.
 */
async function* withIdleBound(source, idleTimeoutMs, onIdle) {
  const iterator = source[Symbol.asyncIterator]()
  try {
    while (true) {
      let timer
      const idle = new Promise((_, reject) => {
        timer = setTimeout(() => {
          onIdle()
          reject(new LlmError(
            `Command Code stream idle timeout after ${idleTimeoutMs}ms`,
            'TIMEOUT',
          ))
        }, idleTimeoutMs)
      })
      let result
      try {
        result = await Promise.race([iterator.next(), idle])
      } finally {
        clearTimeout(timer)
      }
      if (result.done === true) return
      yield result.value
    }
  } finally {
    if (iterator.return !== undefined) {
      try {
        await iterator.return()
      } catch {
        // The consumer controller already owns termination.
      }
    }
  }
}

/**
 * The Command Code adapter. One instance serves every model its route accepts,
 * because the harness model name IS the wire model name.
 */
export class CommandCodeAdapter extends LlmAdapter {
  /**
   * @param {object} options - Operation-local resolution hooks owned by the plugin.
   * @param {() => object} options.options - Current validated connection facts, re-read per operation.
   * @param {() => Promise<string>} options.resolveApiKey - Bearer token for the current facts.
   * @param {() => Promise<readonly object[]>} [options.discoverModels] - Live catalog lookup, when enabled.
   * @param {() => object | undefined} [options.resolveAttachments] - Current durable attachment service; absence rejects image input.
   * @param {(attachments: object, ref: object) => object | undefined} [options.resolveImageAccess] - Map one attachment to a read-only host path for model tools.
   */
  constructor(options) {
    super()
    this.options = options
  }

  providerInfo(provider) {
    return { id: provider, name: 'Command Code' }
  }

  providerRetryPolicy() {
    return this.options.options().retryPolicy
  }

  async listModels(provider) {
    const resolved = this.options.options()
    const live = this.options.discoverModels === undefined
      ? undefined
      : await this.options.discoverModels().catch(() => undefined)
    const catalog = live ?? resolved.models
    return catalog.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      ...model.description === undefined ? {} : { description: model.description },
      // Declared capability is what this route can actually transport. Every
      // model here is image-capable when the catalog says so, and the harness
      // substitutes text for a model that is not.
      inputModalities: [...model.inputModalities ?? ['text']],
    }))
  }

  resolveModel(provider, model) {
    return Promise.resolve(this.modelInfoFor(this.options.options(), provider, model))
  }

  /** Resolve one model's metadata against one connection generation. */
  modelInfoFor(connection, provider, model) {
    const configured = connection.models.find(entry => entry.id === model)
    return {
      provider,
      id: model,
      name: configured?.name ?? model,
      ...configured?.description === undefined ? {} : { description: configured.description },
      // An uncatalogued model is safely treated as text-only: the harness then
      // substitutes text for every image rather than sending one the endpoint
      // may refuse on every later turn of the session.
      inputModalities: [...configured?.inputModalities ?? ['text']],
      context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      reasoning: {
        efforts: REASONING_EFFORTS,
        defaultEffort: ReasoningEffortId(connection.defaultReasoningEffort),
      },
    }
  }

  prepareCall(provider, model) {
    const connection = this.options.options()
    return Promise.resolve({
      model: this.modelInfoFor(connection, provider, model),
      stream: options => this.streamWithConnection(options, connection),
    })
  }

  stream(options) {
    return this.streamWithConnection(options, this.options.options())
  }

  /**
   * Prepare every image in a request, or return undefined for a text-only one.
   *
   * A request carrying an image for a model that does not declare image input
   * is refused here, before anything reaches the network. The harness normally
   * prevents that by substituting text upstream, so this is a safety net for a
   * caller that bypassed the runtime's projection.
   *
   * @param {object} options - The assembled harness request.
   * @param {object} connection - Frozen connection facts for this operation.
   * @param {AbortSignal} signal - Cancellation for the preparation reads.
   * @returns {Promise<object | undefined>} Prepared images and their bounds, or undefined when the request has none.
   * @throws {LlmError} `UNSUPPORTED_CONTENT` when an image cannot be transported.
   */
  async prepareRequestImages(options, connection, signal) {
    const messages = options.messages ?? []
    if (!messages.some(message => contentHasImage(message.content))) return undefined

    const model = connection.models.find(entry => entry.id === options.model)
    if (model?.inputModalities?.includes('image') !== true) {
      throw new LlmError(
        `Command Code model "${options.model}" does not accept image input, and the request carries an image.`,
        'UNSUPPORTED_CONTENT',
      )
    }
    const attachments = this.options.resolveAttachments?.()
    if (attachments === undefined) {
      throw new LlmError(
        'Command Code image input requires the durable attachment service.',
        'UNSUPPORTED_CONTENT',
      )
    }

    const refs = [...collectImageRefs(messages).values()]
    const policy = resolveImagePolicy(model, connection)
    const requestImages = new Map()
    for (const ref of refs) {
      const version = await attachments.readImageRequest(ref, policy, signal)
      requestImages.set(ref.attachmentId, version)
    }

    const resolveAccess = this.options.resolveImageAccess === undefined
      ? undefined
      : ref => this.options.resolveImageAccess(attachments, ref)
    const budget = {
      maxBytes: connection.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES,
      maxImages: connection.maxImagesPerRequest ?? DEFAULT_MAX_IMAGES_PER_REQUEST,
      byteQuantum: connection.imageOffloadByteQuantum ?? DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM,
      countQuantum: connection.imageOffloadCountQuantum ?? DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
    }
    return {
      requestImages,
      resolveAccess,
      // Oldest-first offload keeps one request inside the route's budgets; a
      // replaced occurrence becomes deterministic text rather than vanishing.
      offload: candidateMessages => offloadRequestImagesWithPolicy(candidateMessages, {
        representation: 'base64',
        maxBytes: budget.maxBytes,
        maxImages: budget.maxImages,
        byteQuantum: budget.byteQuantum,
        countQuantum: budget.countQuantum,
        byteLength: ref => requestImages.get(ref.attachmentId)?.bytes ?? 0,
        placeholder: ref => offloadedImageText(ref, resolveAccess?.(ref)),
      }),
    }
  }

  /**
   * Stream one call against frozen connection facts.
   *
   * Connection facts and the credential resolve here and hold for the whole
   * request, so a request can never pair one generation's endpoint with
   * another's secret.
   */
  async * streamWithConnection(options, connection) {
    const apiKey = await this.options.resolveApiKey()
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])

    let media
    try {
      media = await this.prepareRequestImages(options, connection, upstream)
    } catch (error) {
      if (error instanceof LlmError) throw error
      throw new LlmError('Command Code request image preparation failed', 'UNSUPPORTED_CONTENT', { cause: error })
    }

    let body
    try {
      body = serializeGenerateRequest(options, {
        workingDir: connection.workingDir,
        maxTokens: connection.maxTokens,
        reasoningEffort: connection.reasoningEffort,
        threadId: typeof options.sessionId === 'string' && isUuid(options.sessionId)
          ? options.sessionId
          : randomUUID(),
      }, media)
    } catch (error) {
      if (error instanceof LlmError) throw error
      throw new LlmError('Command Code request serialization failed', 'INVALID_REQUEST', { cause: error })
    }

    const headers = {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'x-command-code-version': connection.cliVersion,
      'x-cli-environment': 'production',
      'x-project-slug': projectSlugFromPath(connection.workingDir),
      ...connection.zeroDataRetention ? { 'x-cmd-zdr': '1' } : {},
      ...attributionHeaders(),
    }

    const url = `${connection.baseURL}/alpha/generate`
    let response
    try {
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: upstream })
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw new LlmError('Command Code request aborted by caller', 'ABORTED', { cause: error })
      }
      throw new LlmError(`Command Code request to ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = undefined
      }
      const facts = providerErrorFacts(parsed)
      const detail = [facts.code, facts.message].filter(Boolean).join(' ')
      if (facts.code === 'upgrade_required') {
        throw new LlmError(
          facts.message
            ?? `Command Code refused the request: this account's plan does not include access to ${url}.`,
          httpErrorCode(response.status, detail),
          { status: response.status },
        )
      }
      const retryAfterMs = providerRetryAfterMs(response.headers.get('retry-after'))
      const requestId = response.headers.get('x-request-id')
      throw new LlmError(
        facts.message ?? `Command Code API error (HTTP ${response.status})`,
        httpErrorCode(response.status, detail),
        {
          cause: new Error(raw.length > 0 ? raw.slice(0, 2_000) : `HTTP ${response.status}`),
          status: response.status,
          ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs },
          ...requestId === null || requestId.length === 0
            ? {}
            : { requestId: ProviderRequestId(requestId) },
        },
      )
    }

    if (response.body === null) {
      throw new LlmError('Command Code returned no response body', 'EMPTY_RESPONSE')
    }

    let timedOut = false
    try {
      yield* withIdleBound(
        translateGenerate(readEvents(response.body)),
        connection.streamIdleTimeoutMs,
        () => {
          timedOut = true
          consumer.abort()
        },
      )
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw new LlmError('Command Code request aborted by caller', 'ABORTED', { cause: error })
      }
      if (timedOut) {
        throw new LlmError(
          `Command Code stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      throw error
    } finally {
      consumer.abort()
    }
  }
}
