/**
 * Standalone adapter check: drive the real Command Code generate endpoint
 * through the plugin's own serialize + translate path, with no dsh runtime.
 *
 * Usage: node tests/live-adapter.mjs [model]
 */

import { CommandCodeAdapter } from '../src/adapter.js'
import { readAuthFileApiKey, resolveCliVersion } from '../src/models.js'

const model = process.argv[2] ?? 'deepseek/deepseek-v4.1-flash'
const apiKey = readAuthFileApiKey()
if (apiKey === undefined) throw new Error('no Command Code key found')

const connection = {
  baseURL: 'https://api.commandcode.ai',
  workingDir: process.cwd(),
  cliVersion: resolveCliVersion(),
  maxTokens: 4_096,
  defaultContextWindow: 1_000_000,
  defaultReasoningEffort: 'high',
  reasoningEffort: 'high',
  streamIdleTimeoutMs: 120_000,
  zeroDataRetention: false,
  models: [{ id: model, contextWindow: 1_000_000 }],
  retryPolicy: { mode: 'normal', maxRetries: 0 },
}

const adapter = new CommandCodeAdapter({
  options: () => connection,
  resolveApiKey: async () => apiKey,
})

const tools = [{
  name: 'get_weather',
  description: 'Get the current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
}]

async function run(label, options) {
  process.stdout.write(`\n=== ${label}\n`)
  const blocks = []
  let usage
  let finish
  for await (const chunk of adapter.stream(options)) {
    if (chunk.type === 'block-start') blocks[chunk.index] = { type: chunk.blockType, text: '' }
    else if (chunk.type === 'text-delta') blocks[chunk.index].text += chunk.text
    else if (chunk.type === 'reasoning-delta') blocks[chunk.index].text += chunk.text
    else if (chunk.type === 'tool-call-delta') {
      const b = blocks[chunk.index]
      b.id = chunk.id
      if (chunk.name !== undefined) b.name = chunk.name
      b.arguments = (b.arguments ?? '') + chunk.argumentsDelta
    } else if (chunk.type === 'block-end') blocks[chunk.index] = chunk.block
    else if (chunk.type === 'usage') usage = chunk.usage
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  for (const block of blocks) {
    if (block.type === 'text') console.log('  text     :', JSON.stringify(block.text))
    else if (block.type === 'reasoning') console.log('  reasoning:', JSON.stringify(block.text.slice(0, 90) + (block.text.length > 90 ? '…' : '')))
    else if (block.type === 'tool-call') console.log('  tool-call:', block.name, block.arguments)
  }
  console.log('  usage    :', JSON.stringify(usage))
  console.log('  finish   :', JSON.stringify(finish))
  return { blocks, usage, finish }
}

const first = await run('plain text turn', {
  provider: 'commandcode',
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: PONG' }] }],
  system: 'You are a terse assistant.',
})

const results = [first]

const requested = await run('turn that requests a tool', {
  provider: 'commandcode',
  model,
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'What is the weather in Tokyo? Use the get_weather tool.' }] },
  ],
  system: 'You are a terse assistant. Always use the provided tool when asked about weather.',
  tools,
})
results.push(requested)

const issuedCall = requested.blocks.find(block => block?.type === 'tool-call')
if (issuedCall === undefined) throw new Error('the model issued no tool call; cannot test the result round trip')

const second = await run('tool result round trip', {
  provider: 'commandcode',
  model,
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'What is the weather in Tokyo? Use the get_weather tool.' }] },
    {
      role: 'assistant',
      content: [
        ...(requested.blocks.some(block => block?.type === 'text' && block.text.length > 0)
          ? [{ type: 'text', text: requested.blocks.find(block => block?.type === 'text').text }]
          : []),
        {
          type: 'tool-call',
          id: issuedCall.id,
          name: issuedCall.name,
          arguments: issuedCall.arguments,
        },
      ],
    },
    {
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: issuedCall.id,
        content: [{ type: 'text', text: '18C and clear' }],
      }],
    },
  ],
  system: 'You are a terse assistant. Always use the provided tool when asked about weather.',
  tools,
})
results.push(second)

console.log('\n=== summary')
console.log('turn 1 finish:', first.finish.kind, '| text blocks:', first.blocks.filter(b => b?.type === 'text').length)
console.log('turn 2 finish:', requested.finish.kind, '| tool calls:', requested.blocks.filter(b => b?.type === 'tool-call').length)
console.log('turn 3 finish:', second.finish.kind, '| text:', JSON.stringify(second.blocks.filter(b => b?.type === 'text').map(b => b.text).join('')))
