/**
 * Serialize harness messages into Command Code's `POST /alpha/generate` body.
 *
 * The generate route speaks a provider-neutral event stream rather than an
 * OpenAI chat-completions payload, so this module is the only place that knows
 * its request shape. Three translations carry most of the weight:
 *
 * 1. The system prompt is a request-level field (`params.system`), not a
 *    message. Every harness system message is hoisted into it, because the
 *    route accepts only `user`, `assistant`, and `tool` message roles.
 * 2. Tool results are standalone `role: 'tool'` entries keyed by call id, and
 *    the route requires a result for every tool call it replayed. A call whose
 *    result is missing from history (an interrupted turn) gets a synthetic
 *    error result so the conversation stays replayable.
 * 3. The harness carries a tool result and its call id but not the tool's
 *    name; the name is recovered from the assistant turn that issued the call.
 * 4. An image is carried as an inline base64 data URL part. A tool result's
 *    images cannot ride in its `role: 'tool'` message (that message is
 *    text-only), so they follow it in a separate user turn, matching the shape
 *    Command Code's own CLI sends.
 *
 * @module dsh-llm-commandcode/serialize
 */

import { execFileSync } from 'node:child_process'
import { arch, platform, version as nodeVersion } from 'node:process'

import { LlmError, offloadedImageText, requestImageHandleText } from '@deepseek-ai/dsh-llm'

/** Text substituted for one tool call whose result never reached history. */
export const MISSING_TOOL_RESULT_TEXT =
  'No result — the tool call did not complete (interrupted or lost).'

/** Text substituted for a tool result that carried no text at all. */
export const EMPTY_TOOL_RESULT_TEXT = '(no output)'

/** Tool name sent for a result whose issuing call is no longer in history. */
export const UNKNOWN_TOOL_NAME = 'unknown_tool'

/** Text introducing the user turn that carries a tool result's images. */
export const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:'

const GIT_TIMEOUT_MS = 2_000
const MAX_GIT_STATUS_CHARS = 4_000
const RECENT_COMMIT_COUNT = 10
const gitContextCache = new Map()

/**
 * Read the repository facts Command Code's own CLI sends alongside a request.
 * The result is cached per working directory and never fatal: a directory that
 * is not a repository (or a machine without git) simply reports none.
 *
 * @param {string} workingDir - Absolute working directory.
 * @returns {{isGitRepo: boolean, currentBranch: string, mainBranch: string, gitStatus: string, recentCommits: string[]}} Facts for `body.config`.
 */
export function repositoryContext(workingDir) {
  const cached = gitContextCache.get(workingDir)
  if (cached !== undefined) return cached
  const git = (...args) => execFileSync('git', args, {
    cwd: workingDir,
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  }).trim()
  let context = {
    isGitRepo: false,
    currentBranch: '',
    mainBranch: '',
    gitStatus: '',
    recentCommits: [],
  }
  try {
    if (git('rev-parse', '--is-inside-work-tree') === 'true') {
      context = {
        isGitRepo: true,
        currentBranch: git('rev-parse', '--abbrev-ref', 'HEAD'),
        mainBranch: '',
        gitStatus: git('status', '--short').slice(0, MAX_GIT_STATUS_CHARS),
        recentCommits: git('log', '--oneline', `-${RECENT_COMMIT_COUNT}`)
          .split('\n')
          .filter(line => line.length > 0),
      }
    }
  } catch {
    // Not a repository, no git binary, or an unreadable working directory:
    // the neutral context above is the correct answer.
  }
  gitContextCache.set(workingDir, context)
  return context
}

/** Join the text blocks of a run of content, ignoring every other block type. */
function flattenText(content) {
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** True when any block, including a nested tool result, carries an image. */
export function contentHasImage(content) {
  for (const block of content) {
    if (block.type === 'image') return true
    if (block.type === 'tool-result' && contentHasImage(block.content)) return true
  }
  return false
}

/**
 * Collect every distinct durable image reference in request order.
 *
 * Occurrences are deduplicated by attachment id, because one attachment can be
 * referenced by both a user turn and a tool result, and the request version of
 * it should be computed once.
 *
 * @param {readonly object[]} messages - Complete request history.
 * @returns {Map<string, object>} Attachment id to durable reference, in first-seen order.
 */
export function collectImageRefs(messages) {
  const refs = new Map()
  const walk = content => {
    for (const block of content) {
      if (block.type === 'image') refs.set(block.attachment.attachmentId, block.attachment)
      else if (block.type === 'tool-result') walk(block.content)
    }
  }
  for (const message of messages) walk(message.content)
  return refs
}

/**
 * Parse a tool call's raw argument JSON into the object the route replays.
 * Malformed arguments degrade to an empty object rather than failing the
 * request: the call is history, and dropping the whole turn would be worse
 * than losing a partial argument object.
 */
function parseToolArguments(rawArguments) {
  try {
    const parsed = JSON.parse(rawArguments)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** The tool names and answered call ids visible in history, resolved in one pass. */
function historyIndex(messages) {
  const namesById = new Map()
  const answered = new Set()
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool-call') namesById.set(block.id, block.name)
      }
      continue
    }
    if (message.role !== 'user') continue
    for (const block of message.content) {
      if (block.type === 'tool-result') answered.add(block.toolCallId)
    }
  }
  return { namesById, answered }
}

/**
 * Map harness user-content blocks onto the route's ordered user-input parts.
 *
 * Only top-level text becomes user input. A `tool-result` block's content is
 * the tool's output and is delivered by its own `role: 'tool'` message, so
 * recursing into it here would inject that output as a user turn and break the
 * route's call/result pairing.
 */
function userParts(content) {
  const parts = []
  for (const block of content) {
    if (block.type === 'text' && block.text.length > 0) parts.push({ type: 'text', text: block.text })
  }
  return parts
}

/**
 * Render one durable image reference as an ordered wire part sequence: a stable
 * identity the model can refer to, then the image itself as an inline base64
 * data URL.
 *
 * The identity text is not decoration. It gives the model a name for the image
 * and, when the harness can map the attachment to a host path, a read-only
 * path its file tools may open — so a follow-up turn can work on the normalized
 * copy instead of asking for the image again.
 *
 * @param {object} ref - Durable `ImageAttachmentRef`.
 * @param {object} version - Prepared `RequestImageAttachment` for this request.
 * @param {((ref: object) => object|undefined) | undefined} resolveAccess - Host-path access resolver.
 * @param {boolean} precededByContent - Whether an earlier part already occupies this turn.
 * @returns {object[]} The text handle and the image part, in order.
 * @throws {LlmError} `INVALID_REQUEST` when the attachment was not prepared.
 */
function imageParts(ref, version, resolveAccess, precededByContent) {
  if (version === undefined) {
    throw new LlmError(
      `Command Code request image ${ref.attachmentId} was not prepared.`,
      'INVALID_REQUEST',
    )
  }
  return [
    {
      type: 'text',
      text: `${precededByContent ? '\n' : ''}${requestImageHandleText(ref, version, resolveAccess?.(ref))}`,
    },
    {
      type: 'image',
      image: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`,
      mimeType: version.mediaType,
    },
  ]
}

/**
 * Convert one run of content into wire parts, resolving images as it goes.
 *
 * @param {readonly object[]} content - Harness content blocks.
 * @param {object} media - Prepared request images, access resolver, and bounds.
 * @returns {object[]} Ordered wire parts.
 */
function contentParts(content, media) {
  const parts = []
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image') {
      const ref = block.attachment
      parts.push(...imageParts(
        ref,
        media.requestImages.get(ref.attachmentId),
        media.resolveAccess,
        parts.length > 0,
      ))
      continue
    }
    if (block.type === 'tool-result') parts.push(...contentParts(block.content, media))
  }
  return parts
}

/** Split wire parts into the text-only shape the route wants for a user turn. */
function userContent(parts) {
  if (parts.length === 0) return ''
  if (parts.every(part => part.type === 'text')) {
    return parts.map(part => part.text).join('')
  }
  return parts
}

/**
 * Replace oversized oldest images with their deterministic text placeholder
 * before serialization, so one request cannot exceed the route's byte or count
 * budget.
 *
 * @param {readonly object[]} messages - Complete request history.
 * @param {object} media - Prepared request images, access resolver, and bounds.
 * @returns {readonly object[]} History with the excess occurrences replaced.
 */
function offloadExcessImages(messages, media) {
  return media.offload(messages)
}

/**
 * Resolve the wire spelling of a harness reasoning effort.
 *
 * The route accepts `low`, `high`, and `max`; `off` and unknown levels send
 * nothing, which leaves the model's own thinking default in force.
 *
 * @param {string | undefined} effort - Selected harness effort id.
 * @returns {'low'|'high'|'max'|undefined} The value to send, when any.
 */
export function wireReasoningEffort(effort) {
  switch (effort) {
    case 'low':
    case 'minimal':
      return 'low'
    case 'high':
    case 'medium':
      return 'high'
    case 'max':
    case 'xhigh':
      return 'max'
    default:
      return undefined
  }
}

/**
 * Build the request body for one generate call.
 *
 * @param {object} options - The assembled harness request (`GenerateOptions`).
 * @param {{workingDir: string, maxTokens: number, reasoningEffort?: string, threadId: string}} resolved - Operation-local connection facts.
 * @param {object} [media] - Prepared request images and their bounds; omitted for a text-only request.
 * @returns {object} The `POST /alpha/generate` JSON body.
 * @throws {LlmError} `UNSUPPORTED_CONTENT` when the request carries an image that was not prepared for transport.
 */
export function serializeGenerateRequest(options, resolved, media) {
  const requestMessages = options.messages ?? []
  if (media === undefined && requestMessages.some(message => contentHasImage(message.content))) {
    throw new LlmError(
      `Command Code model "${options.model}" is declared text-only by this adapter, and the request carries image content.`,
      'UNSUPPORTED_CONTENT',
    )
  }
  const messages = media === undefined ? requestMessages : offloadExcessImages(requestMessages, media)

  const { namesById, answered } = historyIndex(messages)
  const systemParts = options.system === undefined ? [] : [options.system]
  const wire = []
  // A tool result's images cannot ride in its text-only `role: 'tool'`
  // message, so they accumulate here and flush as one user turn, matching the
  // shape Command Code's own CLI sends.
  let pendingToolImages = []
  const flushToolImages = () => {
    if (pendingToolImages.length === 0) return
    wire.push({
      role: 'user',
      content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages],
    })
    pendingToolImages = []
  }

  for (const message of messages) {
    if (message.role === 'system') {
      flushToolImages()
      const text = flattenText(message.content)
      if (text.length > 0) systemParts.push(text)
      continue
    }

    if (message.role === 'assistant') {
      flushToolImages()
      const parts = []
      const orphaned = []
      for (const block of message.content) {
        if (block.type === 'text') {
          if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
          continue
        }
        if (block.type !== 'tool-call') continue
        parts.push({
          type: 'tool-call',
          toolCallId: block.id,
          toolName: block.name,
          input: parseToolArguments(block.arguments),
        })
        // A replayed tool call without its result is refused by the route, so
        // an interrupted turn is repaired in place rather than dropped.
        if (!answered.has(block.id)) {
          orphaned.push({
            type: 'tool-result',
            toolCallId: block.id,
            toolName: block.name,
            output: { type: 'error-text', value: MISSING_TOOL_RESULT_TEXT },
          })
        }
      }
      if (parts.length > 0) wire.push({ role: 'assistant', content: parts })
      if (orphaned.length > 0) wire.push({ role: 'tool', content: orphaned })
      continue
    }

    const results = message.content.filter(block => block.type === 'tool-result')
    const regular = message.content.filter(block => block.type !== 'tool-result')
    const parts = media === undefined ? userParts(regular) : contentParts(regular, media)
    if (parts.length > 0 || results.length === 0) {
      flushToolImages()
      wire.push({ role: 'user', content: userContent(parts) })
    }
    for (const result of results) {
      const value = flattenText(result.content) || EMPTY_TOOL_RESULT_TEXT
      wire.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: result.toolCallId,
          toolName: namesById.get(result.toolCallId) ?? UNKNOWN_TOOL_NAME,
          output: result.isError === true
            ? { type: 'error-text', value }
            : { type: 'text', value },
        }],
      })
      if (media !== undefined && contentHasImage(result.content)) {
        pendingToolImages.push(
          ...contentParts(result.content, media).filter(part => part.type === 'image'),
        )
      }
    }
  }
  flushToolImages()

  const tools = (options.tools ?? []).map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))

  return {
    config: {
      workingDir: resolved.workingDir,
      date: new Date().toISOString().slice(0, 10),
      environment: `${platform}-${arch}, Node.js ${nodeVersion}`,
      structure: [],
      ...repositoryContext(resolved.workingDir),
    },
    memory: null,
    taste: null,
    skills: null,
    params: {
      model: options.model,
      messages: wire,
      tools,
      system: systemParts.join('\n\n'),
      max_tokens: options.maxTokens ?? resolved.maxTokens,
      stream: true,
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...resolved.reasoningEffort === undefined
        ? {}
        : { reasoning_effort: resolved.reasoningEffort },
    },
    threadId: resolved.threadId,
  }
}
