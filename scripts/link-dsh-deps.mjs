/**
 * Link the DeepSeek Harness packages this plugin depends on into
 * `./node_modules`, so `npm test` works from a bare clone.
 *
 * dsh ships as one global npm package with every `@deepseek-ai/*` package
 * nested inside it, and its own profile loader links those same directories
 * into a profile's `node_modules` (see `healProfilesModuleFallback` in
 * `@deepseek-ai/dsh-app-boot`). This script does the equivalent for a
 * checkout, so a contributor can run the test suite without installing
 * anything else.
 *
 * Installing the plugin into a profile through `dsh plugin --profile <name>
 * add <this package>` needs none of this: the profile's loader supplies the
 * resolution.
 *
 * Usage: node scripts/link-dsh-deps.mjs
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(packageRoot, 'package.json'))

/** Every `@deepseek-ai/*` package this plugin or its tests import. */
const REQUIRED = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-timeout',
  '@deepseek-ai/schemastery',
]

/** Candidate directories holding a dsh installation's nested dependencies. */
function candidateScopes() {
  const scopes = []
  const push = path => {
    if (path !== undefined && path.length > 0) scopes.push(path)
  }
  // A local install (this checkout declares the packages as peers).
  push(join(packageRoot, 'node_modules', '@deepseek-ai'))
  // The global dsh install, however it is laid out on this machine.
  const globalRoots = [
    process.env.DSH_GLOBAL_ROOT,
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    join(process.env.HOME ?? '', '.local', 'lib', 'node_modules'),
    join(process.env.HOME ?? '', '.npm-global', 'lib', 'node_modules'),
    ...(process.env.NODE_PATH ?? '').split(':'),
  ].filter(root => typeof root === 'string' && root.length > 0)
  for (const root of globalRoots) {
    // dsh nests its dependencies; the scope sits inside its own node_modules.
    push(join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(root, '@deepseek-ai'))
  }
  return scopes
}

/** The first scope that can satisfy every required package. */
function findCompleteScope() {
  const scopes = candidateScopes()
  for (const scope of scopes) {
    if (!existsSync(scope)) continue
    if (REQUIRED.every(name => existsSync(join(scope, name.replace('@deepseek-ai/', ''))))) return scope
  }
  return undefined
}

const scope = findCompleteScope()
if (scope === undefined) {
  console.error('link-dsh-deps: no complete @deepseek-ai package set found.')
  console.error('Install the harness first (npm i -g @deepseek-ai/dsh), or set DSH_GLOBAL_ROOT')
  console.error('to the directory whose node_modules holds @deepseek-ai/dsh.')
  for (const candidate of candidateScopes()) console.error(`  looked in: ${candidate}`)
  process.exit(1)
}

const target = join(packageRoot, 'node_modules', '@deepseek-ai')
mkdirSync(target, { recursive: true })

let linked = 0
for (const entry of readdirSync(scope, { withFileTypes: true })) {
  const source = join(scope, entry.name)
  const destination = join(target, entry.name)
  rmSync(destination, { recursive: true, force: true })
  symlinkSync(source, destination, 'dir')
  linked += 1
}

console.log(`link-dsh-deps: linked ${linked} package(s) from ${scope}`)
// Report resolution through the same mechanism the plugin uses at runtime.
for (const name of REQUIRED) {
  try {
    require.resolve(`${name}/package.json`)
  } catch {
    console.error(`link-dsh-deps: ${name} is not resolvable after linking`)
    process.exit(1)
  }
}
console.log('link-dsh-deps: every required package resolves')
