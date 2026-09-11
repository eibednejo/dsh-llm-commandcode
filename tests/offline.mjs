/**
 * Offline checks for the pure parts of the adapter: request serialization,
 * stream translation, and configuration resolution. No network, no harness.
 *
 * Usage: node tests/offline.mjs
 */

import assert from 'node:assert/strict'

import { CommandCodeAdapter } from '../src/adapter.js'
import { Config, resolveAdapterOptions } from '../src/index.js'
import { compareVersions, parseVersion } from '../scripts/version.mjs'
import {
  inputModalitiesForModel,
  parseDiscoveryPayload,
  projectSlugFromPath,
  resolveImagePolicy,
  resolveModels,
} from '../src/models.js'
import {
  collectImageRefs,
  contentHasImage,
  serializeGenerateRequest,
  wireReasoningEffort,
} from '../src/serialize.js'
import { mapFinishReason, mapUsage, parseEventLine, translateGenerate } from '../src/translate.js'

let checks = 0
const check = (label, fn) => {
  fn()
  checks += 1
  console.log('  ok:', label)
}

const connection = {
  workingDir: '/tmp',
  maxTokens: 64_000,
  reasoningEffort: 'high',
  threadId: '11111111-2222-4333-8444-555555555555',
}

console.log('\nserialize')
check('system messages hoist into params.system and never become messages', () => {
  const body = serializeGenerateRequest({
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4.1-flash',
    system: 'request-level system',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'history system' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
  }, connection)
  assert.equal(body.params.system, 'request-level system\n\nhistory system')
  assert.deepEqual(body.params.messages, [{ role: 'user', content: 'hi' }])
})

check('tool results become role:tool and their text never leaks into a user turn', () => {
  const body = serializeGenerateRequest({
    provider: 'commandcode',
    model: 'm',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'c1', name: 'get_weather', arguments: '{"city":"Tokyo"}' }],
      },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '18C' }] }] },
    ],
  }, connection)
  assert.deepEqual(body.params.messages.map(m => m.role), ['user', 'assistant', 'tool'])
  const tool = body.params.messages[2]
  assert.equal(tool.content[0].output.value, '18C')
  assert.equal(body.params.messages[0].content, 'weather?')
})

check('an interrupted tool call gains a synthetic error result', () => {
  const body = serializeGenerateRequest({
    provider: 'commandcode',
    model: 'm',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'c9', name: 'bash', arguments: '{}' }],
      },
    ],
  }, connection)
  const tool = body.params.messages.find(m => m.role === 'tool')
  assert.equal(tool.content[0].toolCallId, 'c9')
  assert.equal(tool.content[0].output.type, 'error-text')
})

check('isError results are sent as error-text and empty results get a placeholder', () => {
  const body = serializeGenerateRequest({
    provider: 'commandcode',
    model: 'm',
    messages: [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'a', name: 't', arguments: '{}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'a', content: [], isError: true }] },
    ],
  }, connection)
  const tool = body.params.messages.find(m => m.role === 'tool')
  assert.equal(tool.content[0].output.type, 'error-text')
  assert.equal(tool.content[0].output.value, '(no output)')
})

check('tool schemas carry input_schema, and tools omit cleanly', () => {
  const schema = { type: 'object', properties: { city: { type: 'string' } } }
  const body = serializeGenerateRequest({
    provider: 'commandcode',
    model: 'm',
    messages: [],
    tools: [{ name: 'get_weather', description: 'weather', parameters: schema }],
  }, connection)
  assert.deepEqual(body.params.tools, [
    { type: 'function', name: 'get_weather', description: 'weather', input_schema: schema },
  ])
})

check('a request carrying an image is refused when nothing prepared it', () => {
  assert.throws(
    () => serializeGenerateRequest({
      provider: 'commandcode',
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a1' } }] }],
    }, connection),
    error => error.code === 'UNSUPPORTED_CONTENT',
  )
  assert.equal(
    contentHasImage([{ type: 'tool-result', toolCallId: 'x', content: [{ type: 'image', attachment: {} }] }]),
    true,
  )
})

check('collectImageRefs finds images in user turns and nested tool results, deduplicated', () => {
  const a = { attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 1, height: 1 }
  const b = { attachmentId: 'a2', mediaType: 'image/png', bytes: 20, width: 1, height: 1 }
  const refs = collectImageRefs([
    { role: 'user', content: [{ type: 'image', attachment: a }, { type: 'text', text: 'hi' }] },
    {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'image', attachment: b }] }],
    },
    { role: 'user', content: [{ type: 'image', attachment: a }] },
  ])
  assert.deepEqual([...refs.keys()], ['a1', 'a2'])
})

console.log('\nimages')

const imageRef = { attachmentId: 'a1', mediaType: 'image/png', bytes: 4, width: 2, height: 2, name: 'tiny.png' }
const imageBytes = new Uint8Array([1, 2, 3, 4])
const mediaFor = (overrides = {}) => ({
  requestImages: new Map([[imageRef.attachmentId, {
    variantId: 'v1',
    attachment: imageRef,
    data: imageBytes,
    mediaType: 'image/png',
    bytes: 4,
    width: 2,
    height: 2,
  }]]),
  resolveAccess: undefined,
  offload: messages => messages,
  ...overrides,
})

check('an image becomes a data URL part beside its identity text', () => {
  const body = serializeGenerateRequest({
    provider: 'commandcode',
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image', attachment: imageRef }] }],
  }, connection, mediaFor())
  const content = body.params.messages[0].content
  assert.equal(content[0].type, 'text')
  assert.equal(content[0].text, 'what is this?')
  assert.match(content[1].text, /Image "tiny\.png" \(a1\); request preview 2x2px\./)
  assert.equal(content[2].type, 'image')
  assert.equal(content[2].mimeType, 'image/png')
  assert.equal(content[2].image, `data:image/png;base64,${Buffer.from(imageBytes).toString('base64')}`)
})

check('a text-only user turn stays a plain string', () => {
  const body = serializeGenerateRequest({
    provider: 'commandcode',
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'just text' }] }],
  }, connection, mediaFor())
  assert.equal(body.params.messages[0].content, 'just text')
})

check("a tool result's images follow it in their own user turn", () => {
  const body = serializeGenerateRequest({
    provider: 'commandcode',
    model: 'm',
    messages: [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'screenshot', arguments: '{}' }] },
      {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'c1',
          content: [{ type: 'text', text: 'captured' }, { type: 'image', attachment: imageRef }],
        }],
      },
    ],
  }, connection, mediaFor())
  assert.deepEqual(body.params.messages.map(m => m.role), ['assistant', 'tool', 'user'])
  const tool = body.params.messages[1]
  assert.equal(tool.content[0].output.value, 'captured')
  const followUp = body.params.messages[2]
  assert.equal(followUp.content[0].text, 'Attached image(s) from tool result:')
  assert.equal(followUp.content.at(-1).type, 'image')
})

check('an unprepared image reference is refused rather than sent empty', () => {
  assert.throws(
    () => serializeGenerateRequest({
      provider: 'commandcode',
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'missing' } }] }],
    }, connection, mediaFor()),
    error => error.code === 'INVALID_REQUEST',
  )
})

check('oversized history is offloaded through the policy hook before serialization', () => {
  let offloaded = false
  const body = serializeGenerateRequest({
    provider: 'commandcode',
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'kept' }] }],
  }, connection, mediaFor({
    offload: messages => {
      offloaded = true
      return messages
    },
  }))
  assert.equal(offloaded, true)
  assert.equal(body.params.messages[0].content, 'kept')
})

console.log('\nimage policy')

check('a model budget wins over the route default, and low selects the low preset', () => {
  const defaults = { requestImagePixelBudget: 100, requestImageMaxBytes: 200 }
  assert.deepEqual(resolveImagePolicy({ id: 'm' }, defaults), { maxPixels: 100, maxBytes: 200 })
  assert.deepEqual(
    resolveImagePolicy({ id: 'm', imagePixelBudget: 5000 }, defaults),
    { maxPixels: 5000, maxBytes: 200 },
  )
  assert.deepEqual(
    resolveImagePolicy({ id: 'm', imagePixelBudget: 'low' }, defaults),
    { maxPixels: 512 * 512, maxBytes: 200 },
  )
})

check('catalog validation refuses image budgets on a text-only model', () => {
  assert.throws(
    () => resolveModels([{ id: 't', inputModalities: ['text'], imageMaxBytes: 10 }]),
    /cannot declare image request limits/,
  )
  assert.throws(
    () => resolveModels([{ id: 't', inputModalities: ['text'], imagePixelBudget: 'low' }]),
    /cannot declare image request limits/,
  )
})

check('an unknown model id is treated as text-only', () => {
  assert.deepEqual(inputModalitiesForModel('nobody/knows-this'), ['text'])
  assert.deepEqual(inputModalitiesForModel('deepseek/deepseek-v4.1-flash'), ['text', 'image'])
})

check('discovery labels known image models and leaves the rest text-only', () => {
  const models = parseDiscoveryPayload({
    data: [
      { id: 'deepseek/deepseek-v4.1-flash' },
      { id: 'deepseek/deepseek-v4-pro' },
      { id: 'some/brand-new-model' },
    ],
  })
  assert.deepEqual(models[0].inputModalities, ['text', 'image'])
  assert.deepEqual(models[1].inputModalities, ['text'])
  assert.deepEqual(models[2].inputModalities, ['text'])
})

check('reasoning effort maps onto the wire vocabulary and off sends nothing', () => {
  assert.equal(wireReasoningEffort('low'), 'low')
  assert.equal(wireReasoningEffort('minimal'), 'low')
  assert.equal(wireReasoningEffort('medium'), 'high')
  assert.equal(wireReasoningEffort('high'), 'high')
  assert.equal(wireReasoningEffort('xhigh'), 'max')
  assert.equal(wireReasoningEffort('max'), 'max')
  assert.equal(wireReasoningEffort('off'), undefined)
  assert.equal(wireReasoningEffort(undefined), undefined)
})

console.log('\ntranslate')

const collect = async events => {
  const chunks = []
  for await (const chunk of translateGenerate(events)) chunks.push(chunk)
  return chunks
}

await (async () => {
  const chunks = await collect([
    { type: 'start' },
    { type: 'reasoning-start', id: 'reasoning-0' },
    { type: 'reasoning-delta', id: 'reasoning-0', text: 'think ' },
    { type: 'reasoning-delta', id: 'reasoning-0', text: 'more' },
    { type: 'text-start', id: 'txt-0' },
    { type: 'reasoning-end', id: 'reasoning-0' },
    { type: 'text-delta', id: 'txt-0', text: 'PONG' },
    { type: 'text-end', id: 'txt-0' },
    { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 10, inputTokenDetails: { noCacheTokens: 4, cacheReadTokens: 6 }, outputTokens: 2, totalTokens: 12, reasoningTokens: 1 } },
    { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 10, inputTokenDetails: { noCacheTokens: 4, cacheReadTokens: 6 }, outputTokens: 2, totalTokens: 12, reasoningTokens: 1 } },
    { type: 'provider-metadata', providerMetadata: {} },
  ])
  check('emits block-start, deltas, block-end, usage, then finish', () => {
    assert.deepEqual(chunks.map(c => c.type), [
      'block-start', 'reasoning-delta', 'reasoning-delta', 'block-start',
      'block-end', 'text-delta', 'block-end', 'usage', 'finish',
    ])
    const ends = chunks.filter(c => c.type === 'block-end').map(c => c.block)
    assert.deepEqual(ends.find(b => b.type === 'reasoning'), { type: 'reasoning', text: 'think more' })
    assert.deepEqual(ends.find(b => b.type === 'text'), { type: 'text', text: 'PONG' })
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.equal(chunks.filter(c => c.type === 'usage')[0].usage.inputTokens, 4)
    assert.equal(chunks.filter(c => c.type === 'usage')[0].usage.cacheReadTokens, 6)
  })

  const toolChunks = await collect([
    { type: 'start' },
    { type: 'tool-input-start', id: 'call_1', toolName: 'get_weather' },
    { type: 'tool-input-delta', id: 'call_1', delta: '{"city":' },
    { type: 'tool-input-delta', id: 'call_1', delta: '"Tokyo"}' },
    { type: 'tool-input-end', id: 'call_1' },
    { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'Tokyo' } },
    { type: 'finish-step', finishReason: 'tool-calls' },
    { type: 'finish', finishReason: 'tool-calls' },
  ])
  check('assembles one tool call from deltas and the authoritative parsed input', () => {
    const ends = toolChunks.filter(c => c.type === 'block-end')
    assert.equal(ends.length, 1)
    assert.deepEqual(ends[0].block, {
      type: 'tool-call',
      id: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"Tokyo"}',
    })
    assert.equal(toolChunks.at(-1).reason.kind, 'tool-calls')
  })

  check('a completed response with no content is an error, not an empty success', async () => {
    const empty = await collect([{ type: 'finish', finishReason: 'stop' }])
    assert.equal(empty.at(-1).reason.kind, 'error')
  })

  check('a truncated stream throws STREAM_CLOSED', async () => {
    await assert.rejects(
      () => collect([{ type: 'text-start', id: 'txt-0' }, { type: 'text-delta', id: 'txt-0', text: 'partial' }]),
      error => error.code === 'STREAM_CLOSED',
    )
  })

  check('a provider error event throws with its own message', async () => {
    await assert.rejects(
      () => collect([{ type: 'error', error: { message: 'Tool result is missing', code: 'bad_request' } }]),
      error => error.message === 'Tool result is missing',
    )
  })

  check('an upstream-error finish reason throws instead of silently stopping', async () => {
    await assert.rejects(
      () => collect([{ type: 'finish', finishReason: 'error', rawFinishReason: 'network-error' }]),
      error => /upstream provider connection failed/.test(error.message),
    )
  })

  check('reasonable event-line parsing tolerates framing', () => {
    assert.deepEqual(parseEventLine('data: {"type":"start"}'), { type: 'start' })
    assert.deepEqual(parseEventLine('{"type":"start"}'), { type: 'start' })
    assert.equal(parseEventLine(''), undefined)
    assert.equal(parseEventLine(': keep-alive'), undefined)
    assert.equal(parseEventLine('[DONE]'), undefined)
    assert.equal(parseEventLine('not json'), undefined)
  })

  check('finish reasons and usage map onto the harness vocabulary', () => {
    assert.equal(mapFinishReason('stop').kind, 'stop')
    assert.equal(mapFinishReason(undefined).kind, 'stop')
    assert.equal(mapFinishReason('tool_calls').kind, 'tool-calls')
    assert.equal(mapFinishReason('max_tokens').kind, 'max-tokens')
    assert.equal(mapFinishReason('content_filter').kind, 'error')
    assert.equal(mapUsage(undefined), undefined)
    assert.deepEqual(mapUsage({ inputTokens: 5, outputTokens: 3 }), { inputTokens: 5, outputTokens: 3 })
  })
})()

console.log('\nconfig')

check('schema defaults resolve a complete configuration', () => {
  const parsed = Config({})
  assert.equal(parsed.apiKeyEnv, 'COMMAND_CODE_API_KEY')
  assert.equal(parsed.baseURL, 'https://api.commandcode.ai')
  assert.equal(parsed.modelCatalog, 'auto')
  assert.equal(parsed.zeroDataRetention, false)
  assert.ok(Array.isArray(parsed.models) && parsed.models.length > 0)
  assert.equal(parsed.models.every(m => Array.isArray(m.inputModalities) && m.inputModalities.length > 0), true)
})

check('a bare config resolves without schema normalization', () => {
  const resolved = resolveAdapterOptions({})
  assert.equal(resolved.models.length, 5)
  assert.equal(resolved.defaultContextWindow, 1_000_000)
  assert.equal(String(resolved.apiKeyEnv), 'COMMAND_CODE_API_KEY')
})

check('invalid bounds fail loudly', () => {
  assert.throws(() => resolveAdapterOptions({ maxTokens: 0 }), /maxTokens/)
  assert.throws(() => resolveAdapterOptions({ streamIdleTimeoutMs: -1 }), /streamIdleTimeoutMs/)
  assert.throws(() => resolveAdapterOptions({ defaultReasoningEffort: 'turbo' }), /defaultReasoningEffort/)
  assert.throws(() => resolveAdapterOptions({ models: [{ id: '' }] }), /non-empty/)
  assert.throws(() => resolveAdapterOptions({ models: [{ id: 'a' }, { id: 'a' }] }), /duplicate/)
  assert.throws(() => resolveAdapterOptions({ models: [{ id: 'a', inputModalities: [] }] }), /inputModalities/)
})

check('catalog validation rejects a text-only model that declares image limits', () => {
  assert.throws(
    () => resolveModels([{ id: 'a', inputModalities: ['text'] }, { id: 'b', inputModalities: ['speech'] }]),
    /inputModalities/,
  )
})

check('discovery payloads parse, and unrecognized ones are refused', () => {
  const models = parseDiscoveryPayload({
    object: 'list',
    data: [{ id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', context_length: 1_000_000 }],
  })
  assert.deepEqual(models, [{
    id: 'deepseek/deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    contextWindow: 1_000_000,
    inputModalities: ['text'],
  }])
  assert.equal(parseDiscoveryPayload({ models: {} }), undefined)
  assert.equal(parseDiscoveryPayload({ data: [] }), undefined)
})

check('project slugs match the CLI convention', () => {
  assert.equal(projectSlugFromPath('/home/user/work/my-app'), 'home-user-work-my-app')
  assert.equal(projectSlugFromPath('C:\\Users\\dev\\project'), 'users-dev-project')
  assert.equal(projectSlugFromPath('/'), 'project')
  assert.equal(projectSlugFromPath(''), 'project')
})

console.log('\nadapter metadata')

check('declared capabilities follow the catalog', async () => {
  const adapter = new CommandCodeAdapter({
    options: () => ({ ...connection, models: resolveModels(undefined), defaultContextWindow: 1_000_000, defaultReasoningEffort: 'high' }),
    resolveApiKey: async () => 'unused',
  })
  const models = await adapter.listModels('commandcode')
  assert.equal(models.length, 5)
  const byId = new Map(models.map(model => [model.id, model]))
  assert.deepEqual(byId.get('deepseek/deepseek-v4.1-flash').inputModalities, ['text', 'image'])
  assert.deepEqual(byId.get('deepseek/deepseek-v4-flash-vision-exp').inputModalities, ['text', 'image'])
  assert.deepEqual(byId.get('deepseek/deepseek-v4-pro').inputModalities, ['text'])
  const resolved = await adapter.resolveModel('commandcode', 'deepseek/deepseek-v4.1-flash')
  assert.equal(resolved.context.contextWindow, 1_000_000)
  assert.equal(resolved.defaultMaxTokens, 64_000)
  assert.deepEqual(resolved.reasoning.efforts.map(e => String(e.id)), ['off', 'low', 'high', 'max'])
  assert.deepEqual(resolved.inputModalities, ['text', 'image'])
})

check('an uncatalogued model resolves as text-only', async () => {
  const adapter = new CommandCodeAdapter({
    options: () => ({ ...connection, models: resolveModels(undefined), defaultContextWindow: 1_000_000, defaultReasoningEffort: 'high' }),
    resolveApiKey: async () => 'unused',
  })
  const resolved = await adapter.resolveModel('commandcode', 'nobody/knows-this')
  assert.deepEqual(resolved.inputModalities, ['text'])
  assert.equal(resolved.context.contextWindow, 1_000_000)
})

console.log('\nupgrade-check version ordering')

const version = text => parseVersion(text)
const ordering = (left, right) => {
  const result = compareVersions(version(left), version(right))
  return result < 0 ? 'older' : result > 0 ? 'newer' : 'equal'
}

check('versions parse with and without a leading v, and prereleases split out', () => {
  assert.deepEqual(version('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: undefined })
  assert.deepEqual(version('v1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: undefined })
  assert.deepEqual(version('0.1.5-rc.2'), { major: 0, minor: 1, patch: 5, prerelease: 'rc.2' })
  assert.deepEqual(version('  1.0.0-alpha.1  '), { major: 1, minor: 0, patch: 0, prerelease: 'alpha.1' })
  assert.equal(version('not-a-version'), undefined)
  assert.equal(version('1.2'), undefined)
  assert.equal(version(''), undefined)
})

check('release ordering follows major, minor, then patch', () => {
  assert.equal(ordering('1.0.0', '2.0.0'), 'older')
  assert.equal(ordering('2.0.0', '1.9.9'), 'newer')
  assert.equal(ordering('1.2.0', '1.10.0'), 'older')
  assert.equal(ordering('0.1.5', '0.1.5'), 'equal')
})

check('a prerelease is older than its release', () => {
  assert.equal(ordering('0.1.5-rc.2', '0.1.5'), 'older')
  assert.equal(ordering('1.0.0-alpha', '1.0.0'), 'older')
  assert.equal(ordering('1.0.0', '1.0.0-rc.1'), 'newer')
})

check('prerelease identifiers order numerically, and numeric before alphanumeric', () => {
  assert.equal(ordering('0.1.5-rc.1', '0.1.5-rc.2'), 'older')
  assert.equal(ordering('0.1.5-rc.10', '0.1.5-rc.9'), 'newer')
  assert.equal(ordering('1.0.0-alpha', '1.0.0-beta'), 'older')
  assert.equal(ordering('1.0.0-1', '1.0.0-alpha'), 'older')
  assert.equal(ordering('1.0.5-alpha.2', '1.0.5-alpha.10'), 'older')
  assert.equal(ordering('1.0.0-alpha', '1.0.0-alpha.1'), 'older')
})

check('the real dist-tag trap is detected: latest trails next', () => {
  // 0.1.5-rc.1 is published as `latest` while `next` is 0.1.5-rc.2, so a plain
  // `npm i -g` would move a user backwards. The check must see that.
  assert.equal(ordering('0.1.5-rc.1', '0.1.5-rc.2'), 'older')
  assert.equal(ordering('0.1.5-rc.2', '0.1.5-rc.1'), 'newer')
  assert.equal(ordering('0.1.5-alpha.2', '0.1.5-rc.1'), 'older')
})

console.log(`\n${checks} checks passed\n`)
