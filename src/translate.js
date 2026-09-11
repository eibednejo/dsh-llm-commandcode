/**
 * Translate Command Code's generate event stream into the harness
 * `StreamChunk` protocol.
 *
 * The route answers with newline-delimited JSON events (not SSE) whose block
 * identities are opaque strings (`txt-0`, `reasoning-0`, `call_…`), so this
 * translator keeps one stateful harness block per wire identity and allocates
 * harness indexes in first-seen order.
 *
 * Chunks reach the loop in the order the route sent them: a block's deltas are
 * followed by its own `block-end`, and `usage` precedes the terminal `finish`.
 * Nothing is emitted after `finish`, so the trailing `provider-metadata` event
 * is ignored rather than surfaced.
 *
 * @module dsh-llm-commandcode/translate
 */

import { EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'

/** Parse one newline-delimited event line, tolerating SSE framing and blanks. */
export function parseEventLine(line) {
  let trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.startsWith(':') || trimmed.startsWith('event:')) return undefined
  if (trimmed.startsWith('data:')) trimmed = trimmed.slice(5).trim()
  if (trimmed.length === 0 || trimmed === '[DONE]') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/**
 * Split a byte stream into parsed generate events, buffering across read
 * boundaries. Unparseable lines are dropped: the route interleaves keep-alive
 * and comment frames that carry no event, and a truncated final line is not a
 * protocol violation on its own.
 *
 * @param {ReadableStream<Uint8Array>} body - Response body.
 * @returns {AsyncGenerator<object>} Parsed events in arrival order.
 */
export async function* readEvents(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const event = parseEventLine(line)
        if (event !== undefined) yield event
      }
    }
    const tail = parseEventLine(buffer)
    if (tail !== undefined) yield tail
  } finally {
    try {
      await reader.cancel()
    } catch {
      // The reader may already be closed or cancelled by the abort path.
    }
  }
}

/** Map the route's finish vocabulary onto the harness finish reason. */
export function mapFinishReason(reason) {
  switch (reason) {
    case undefined:
    case null:
    case '':
    case 'stop':
      return { kind: 'stop' }
    case 'tool-calls':
    case 'tool_calls':
      return { kind: 'tool-calls' }
    case 'length':
    case 'max-tokens':
    case 'max_tokens':
    case 'max_output_tokens':
      return { kind: 'max-tokens' }
    default:
      return {
        kind: 'error',
        failure: {
          message: `model stopped: ${String(reason)}`,
          code: String(reason).toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
        },
      }
  }
}

/**
 * Map the route's token accounting onto the harness convention, whose counts
 * are DISJOINT: `inputTokens` is uncached input only and cached input is
 * reported separately.
 *
 * @param {object | undefined} usage - `usage` or `totalUsage` from the stream.
 * @returns {object | undefined} Harness usage, or undefined when absent.
 */
export function mapUsage(usage) {
  if (usage === undefined || usage === null) return undefined
  const details = usage.inputTokenDetails ?? {}
  const cacheReadTokens = Number.isFinite(details.cacheReadTokens)
    ? details.cacheReadTokens
    : Number.isFinite(usage.cachedInputTokens) ? usage.cachedInputTokens : 0
  const totalInput = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0
  const inputTokens = Number.isFinite(details.noCacheTokens)
    ? details.noCacheTokens
    : Math.max(0, totalInput - cacheReadTokens)
  const outputTokens = Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0
  const reasoningTokens = Number.isFinite(usage.reasoningTokens)
    ? usage.reasoningTokens
    : usage.outputTokenDetails?.reasoningTokens
  return {
    inputTokens,
    outputTokens,
    ...Number.isFinite(usage.totalTokens) ? { totalTokens: usage.totalTokens } : {},
    ...cacheReadTokens > 0 ? { cacheReadTokens } : {},
    ...Number.isFinite(reasoningTokens) ? { reasoningTokens } : {},
  }
}

/** Render one protocol failure into a thrown LlmError. */
function streamFailure(event) {
  const raw = event.error ?? event.message ?? event
  const message = typeof raw === 'string'
    ? raw
    : typeof raw?.message === 'string'
      ? raw.message
      : 'Command Code reported a stream error'
  const code = typeof raw?.code === 'string' ? raw.code : undefined
  return new LlmError(message, code ?? 'SERVER')
}

/**
 * Translate parsed events into harness chunks.
 *
 * @param {AsyncIterable<object>} events - Parsed generate events.
 * @returns {AsyncGenerator<object>} Harness `StreamChunk`s.
 * @throws {LlmError} On a provider error event, an upstream-connection finish, or a stream that ends without `finish`.
 */
export async function* translateGenerate(events) {
  let nextIndex = 0
  /** @type {Map<string, {index: number, kind: string, text: string, wireId: string, name?: string, closed: boolean}>} */
  const blocks = new Map()
  let lastTextKey
  let lastReasoningKey
  let lastToolKey
  let sawBlock = false
  let sawFinish = false
  let pendingUsage
  let pendingFinish

  function open(kind, wireId) {
    const block = { index: nextIndex++, kind, text: '', wireId, closed: false }
    blocks.set(`${kind}:${wireId}`, block)
    sawBlock = true
    return block
  }

  function find(kind, wireId, lastKey) {
    if (wireId !== undefined && blocks.has(`${kind}:${wireId}`)) {
      return blocks.get(`${kind}:${wireId}`)
    }
    return lastKey === undefined ? undefined : blocks.get(lastKey)
  }

  for await (const event of events) {
    if (event === undefined || event === null || typeof event !== 'object') continue
    if (event.error !== undefined && event.type === undefined) throw streamFailure(event)

    switch (event.type) {
      case 'text-start': {
        const block = open('text', event.id ?? `text-${nextIndex}`)
        lastTextKey = `text:${block.wireId}`
        yield { type: 'block-start', index: block.index, blockType: 'text' }
        break
      }
      case 'text-delta': {
        const text = typeof event.text === 'string' ? event.text : ''
        if (text.length === 0) break
        let block = find('text', event.id, lastTextKey)
        if (block === undefined) {
          block = open('text', event.id ?? `text-${nextIndex}`)
          lastTextKey = `text:${block.wireId}`
          yield { type: 'block-start', index: block.index, blockType: 'text' }
        }
        if (block.closed) break
        block.text += text
        yield { type: 'text-delta', index: block.index, text }
        break
      }
      case 'text-end': {
        const block = find('text', event.id, lastTextKey)
        if (block === undefined || block.closed) break
        block.closed = true
        yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
        break
      }
      case 'reasoning-start': {
        const block = open('reasoning', event.id ?? `reasoning-${nextIndex}`)
        lastReasoningKey = `reasoning:${block.wireId}`
        yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
        break
      }
      case 'reasoning-delta': {
        const text = typeof event.text === 'string' ? event.text : ''
        if (text.length === 0) break
        let block = find('reasoning', event.id, lastReasoningKey)
        if (block === undefined) {
          block = open('reasoning', event.id ?? `reasoning-${nextIndex}`)
          lastReasoningKey = `reasoning:${block.wireId}`
          yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
        }
        if (block.closed) break
        block.text += text
        yield { type: 'reasoning-delta', index: block.index, text }
        break
      }
      case 'reasoning-end': {
        const block = find('reasoning', event.id, lastReasoningKey)
        if (block === undefined || block.closed) break
        block.closed = true
        yield {
          type: 'block-end',
          index: block.index,
          block: { type: 'reasoning', text: block.text },
        }
        break
      }
      case 'tool-input-start': {
        const wireId = event.id ?? `tool-${nextIndex}`
        const block = open('tool-call', wireId)
        block.name = typeof event.toolName === 'string' ? event.toolName : ''
        lastToolKey = `tool-call:${wireId}`
        yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        break
      }
      case 'tool-input-delta': {
        const delta = typeof event.delta === 'string' ? event.delta : ''
        if (delta.length === 0) break
        let block = find('tool-call', event.id, lastToolKey)
        if (block === undefined) {
          block = open('tool-call', event.id ?? `tool-${nextIndex}`)
          lastToolKey = `tool-call:${block.wireId}`
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (block.closed) break
        block.text += delta
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: block.wireId,
          ...block.name === undefined || block.name.length === 0 ? {} : { name: block.name },
          argumentsDelta: delta,
        }
        break
      }
      case 'tool-call': {
        const wireId = event.toolCallId ?? event.id ?? `tool-${nextIndex}`
        let block = find('tool-call', wireId, lastToolKey)
        if (block === undefined) {
          block = open('tool-call', wireId)
          lastToolKey = `tool-call:${wireId}`
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        const name = typeof event.toolName === 'string' && event.toolName.length > 0
          ? event.toolName
          : block.name ?? ''
        // The route sends the authoritative parsed input, while deltas carried a
        // raw JSON fragment; the parsed form wins so the recorded arguments are
        // always valid JSON.
        const parsedArguments = event.input === undefined
          ? block.text
          : JSON.stringify(event.input)
        if (!block.closed) {
          block.closed = true
          yield {
            type: 'block-end',
            index: block.index,
            block: { type: 'tool-call', id: wireId, name, arguments: parsedArguments },
          }
        }
        break
      }
      case 'tool-input-end':
      case 'start':
      case 'start-step':
      case 'tool-result':
      case 'provider-metadata':
        break
      case 'finish-step': {
        pendingUsage = mapUsage(event.usage) ?? pendingUsage
        pendingFinish = event.finishReason ?? event.rawFinishReason ?? pendingFinish
        break
      }
      case 'finish': {
        const reason = event.finishReason ?? event.rawFinishReason ?? pendingFinish
        const raw = event.rawFinishReason ?? event.finishReason
        if (typeof raw === 'string' && /^(?:network|connection|upstream)[-_\s]?error$/i.test(raw)) {
          throw new LlmError(
            `Command Code finished with reason "${raw}" — the upstream provider connection failed mid-stream`,
            'TRANSPORT',
          )
        }
        const usage = mapUsage(event.totalUsage) ?? pendingUsage
        const finishReason = mapFinishReason(reason)
        sawFinish = true
        if (usage !== undefined) yield { type: 'usage', usage }
        yield {
          type: 'finish',
          reason: finishReason.kind === 'stop' && !sawBlock
            ? {
              kind: 'error',
              failure: {
                message: 'model returned a completed response with no content',
                code: EMPTY_RESPONSE_CODE,
              },
            }
            : finishReason,
        }
        return
      }
      case 'error':
        throw streamFailure(event)
      default:
        break
    }
  }

  if (!sawFinish) {
    throw new LlmError(
      'Command Code stream ended before its finish event — the response was truncated',
      'STREAM_CLOSED',
    )
  }
}
