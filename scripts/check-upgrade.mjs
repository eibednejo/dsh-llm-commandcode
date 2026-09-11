#!/usr/bin/env node
/**
 * Upgrade DeepSeek Harness, re-verify this plugin against the new build, and
 * roll back automatically when it does not survive.
 *
 * A dsh plugin depends on a 0.x prerelease harness whose own README promises
 * breaking changes, so "it upgraded fine" is a claim that has to be earned per
 * release. This script earns it: it records the running version, proves the
 * plugin is healthy *before* touching anything, installs the target, re-proves
 * it, and restores the previous version if any step fails.
 *
 * The pre-upgrade baseline matters as much as the post-upgrade check. Without
 * it, an upgrade that lands on an already-broken machine gets blamed for a
 * failure it did not cause.
 *
 * Usage:
 *   node scripts/check-upgrade.mjs [options]
 *
 * Options:
 *   --to <tag|version>   Target to install (default: next)
 *   --skip-live          Skip the live model turn (offline checks only)
 *   --allow-downgrade    Proceed even when the target is not newer
 *   --dry-run            Print the plan and exit without installing anything
 *   --keep               Do not roll back when the target fails verification
 *   --timeout <seconds>  Live-turn timeout (default: 180)
 *
 * Exit codes:
 *   0  the target is installed and verified (including "already current")
 *   1  the install itself failed; nothing was changed
 *   2  the target failed verification; the previous version was restored and verified
 *   3  the target failed verification and the rollback could not be verified
 *
 * A rollback exits nonzero on purpose: the machine is healthy again, but the
 * upgrade the caller asked for did not happen, and automation must be able to
 * tell those apart.
 *
 * @module dsh-llm-commandcode/check-upgrade
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareVersions, parseVersion } from './version.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HARNESS_PACKAGE = '@deepseek-ai/dsh'
const PLUGIN_NAME = 'dsh-llm-commandcode'
const DEFAULT_PROFILE = 'headless'
const MARKER = 'UPGRADE-OK'

// ---------------------------------------------------------------- arguments

const options = {
  to: 'next',
  skipLive: false,
  allowDowngrade: false,
  dryRun: false,
  keep: false,
  timeoutSeconds: 180,
}

const argv = process.argv.slice(2)
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index]
  if (flag === '--to') options.to = argv[++index]
  else if (flag === '--skip-live') options.skipLive = true
  else if (flag === '--allow-downgrade') options.allowDowngrade = true
  else if (flag === '--dry-run') options.dryRun = true
  else if (flag === '--keep') options.keep = true
  else if (flag === '--timeout') options.timeoutSeconds = Number(argv[++index])
  else if (flag === '--help' || flag === '-h') {
    console.log('usage: node scripts/check-upgrade.mjs [--to <tag|version>] [--skip-live]')
    console.log('                                        [--allow-downgrade] [--dry-run]')
    console.log('                                        [--keep] [--timeout <seconds>]')
    process.exit(0)
  } else {
    console.error(`check-upgrade: unknown option ${JSON.stringify(flag)}`)
    process.exit(1)
  }
}
if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
  console.error('check-upgrade: --timeout must be a positive number of seconds')
  process.exit(1)
}

// ------------------------------------------------------------------ helpers

const PASS = '\u001b[32m\u2713\u001b[0m'
const FAIL = '\u001b[31m\u2717\u001b[0m'
const WARN = '\u001b[33m!\u001b[0m'
const INFO = '\u001b[36m\u00b7\u001b[0m'

const step = message => console.log(`\n${message}`)
const pass = message => console.log(`  ${PASS} ${message}`)
const fail = message => console.log(`  ${FAIL} ${message}`)
const warn = message => console.log(`  ${WARN} ${message}`)
const info = message => console.log(`  ${INFO} ${message}`)

/** Run one command, capturing both streams. Never throws on a nonzero exit. */
function run(command, args, { timeoutMs = 600_000, cwd = packageRoot } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
  return {
    status: result.status ?? (result.error === undefined ? 0 : 1),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  }
}

/** The tail of a command's output, for a failure report that stays readable. */
function tail(result, lines = 12) {
  const text = `${result.stdout}\n${result.stderr}`.trim()
  if (text.length === 0) return '    (no output)'
  return text
    .split('\n')
    .slice(-lines)
    .map(line => `    ${line}`)
    .join('\n')
}

/**
 * Parse a semver-shaped version, including `0.1.5-rc.2` prereleases.
 * Re-exported from {@link ./version.mjs} for the module's documented surface.
 */
export { compareVersions, parseVersion } from './version.mjs'

/** The harness version currently installed, or undefined when it is not. */
function installedVersion() {
  const result = run('npm', ['ls', '-g', '--depth=0', '--json', HARNESS_PACKAGE])
  try {
    const parsed = JSON.parse(result.stdout)
    return parsed.dependencies?.[HARNESS_PACKAGE]?.version
  } catch {
    return undefined
  }
}

/** The version a dist-tag or explicit version resolves to on the registry. */
function resolveTargetVersion(target) {
  const result = run('npm', ['view', `${HARNESS_PACKAGE}@${target}`, 'version'])
  const version = result.stdout.trim()
  return result.status === 0 && version.length > 0 ? version : undefined
}

// ------------------------------------------------------------- verification

/** Re-link the plugin's dsh dependencies, then run the offline suite. */
function verifyOffline(label) {
  const linker = run('node', ['scripts/link-dsh-deps.mjs'])
  if (linker.status !== 0) {
    fail(`${label}: dependency linking failed`)
    console.log(tail(linker))
    return false
  }
  const tests = run('node', ['tests/offline.mjs'])
  const summary = /(\d+) checks passed/.exec(tests.stdout)
  if (tests.status !== 0 || summary === null) {
    fail(`${label}: offline suite failed`)
    console.log(tail(tests))
    return false
  }
  pass(`${label}: offline suite passed (${summary[1]} checks)`)
  return true
}

/** True when a Command Code credential is reachable from this machine. */
function hasCredential() {
  if (typeof process.env.COMMAND_CODE_API_KEY === 'string' && process.env.COMMAND_CODE_API_KEY.length > 0) {
    return true
  }
  return existsSync(join(homedir(), '.commandcode', 'auth.json'))
}

/** True when the chosen profile's composed config loads this plugin. */
function profileLoadsPlugin(profile) {
  const result = run('dsh', ['--profile', profile, '--dump-config'])
  if (result.status !== 0) return undefined
  return result.stdout.includes(PLUGIN_NAME)
}

/**
 * Drive one real agent turn through a dsh profile, so the check covers the
 * live seam — plugin loading, credential resolution, the request, the stream —
 * and not only the pure functions the offline suite exercises.
 *
 * @param {string} label - Prefix for output lines.
 * @returns {'passed'|'failed'|'skipped'} Outcome.
 */
function verifyLive(label) {
  if (options.skipLive) {
    info(`${label}: live turn skipped (--skip-live)`)
    return 'skipped'
  }
  const loaded = profileLoadsPlugin(DEFAULT_PROFILE)
  if (loaded === undefined) {
    info(`${label}: live turn skipped (no '${DEFAULT_PROFILE}' profile configured)`)
    return 'skipped'
  }
  if (!loaded) {
    info(`${label}: live turn skipped (profile '${DEFAULT_PROFILE}' does not load ${PLUGIN_NAME})`)
    return 'skipped'
  }
  if (!hasCredential()) {
    info(`${label}: live turn skipped (no Command Code credential found)`)
    return 'skipped'
  }

  const workdir = mkdtempSync(join(tmpdir(), 'dsh-upgrade-'))
  try {
    const result = run(
      'dsh',
      ['--profile', DEFAULT_PROFILE, `Reply with exactly: ${MARKER}`],
      { cwd: workdir, timeoutMs: options.timeoutSeconds * 1_000 },
    )
    if (result.status !== 0 || !result.stdout.includes(MARKER)) {
      fail(`${label}: live agent turn failed`)
      console.log(tail(result))
      return 'failed'
    }
    pass(`${label}: live agent turn passed`)
    return 'passed'
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------------ install

function install(version) {
  const result = run('npm', ['install', '-g', '--no-audit', '--no-fund', `${HARNESS_PACKAGE}@${version}`])
  if (result.status !== 0) {
    fail(`install of ${version} failed`)
    console.log(tail(result))
    return false
  }
  const now = installedVersion()
  if (now !== version) {
    fail(`install of ${version} reported success but ${now ?? 'nothing'} is installed`)
    return false
  }
  return true
}

// --------------------------------------------------------------------- main

console.log(`${PLUGIN_NAME}: upgrade check`)
console.log(`  plugin:  ${packageRoot}`)
console.log(`  target:  ${HARNESS_PACKAGE}@${options.to}`)

const before = installedVersion()
if (before === undefined) {
  fail(`${HARNESS_PACKAGE} is not installed globally`)
  console.log(`    install it first: npm install -g ${HARNESS_PACKAGE}`)
  process.exit(1)
}
const targetVersion = resolveTargetVersion(options.to)
if (targetVersion === undefined) {
  fail(`cannot resolve ${HARNESS_PACKAGE}@${options.to} on the registry`)
  process.exit(1)
}

console.log(`  current: ${before}`)
console.log(`  resolves to: ${targetVersion}`)

const beforeParsed = parseVersion(before)
const targetParsed = parseVersion(targetVersion)
if (beforeParsed !== undefined && targetParsed !== undefined) {
  const order = compareVersions(targetParsed, beforeParsed)
  if (order === 0) {
    step(`Already at ${targetVersion}`)
    // Still verify: the point is the state of this machine, not the number.
  } else if (order < 0 && !options.allowDowngrade) {
    step('Refusing to downgrade')
    warn(`${options.to} resolves to ${targetVersion}, which is OLDER than the installed ${before}`)
    info('dsh\'s dist-tags are not monotonic: `latest` trails `next`. Pass --allow-downgrade to override.')
    process.exit(0)
  } else if (order < 0) {
    warn(`downgrading ${before} -> ${targetVersion}`)
  }
}

if (options.dryRun) {
  step('Dry run: plan')
  info(`1. verify ${PLUGIN_NAME} against the installed ${before} (baseline)`)
  info(`2. npm install -g ${HARNESS_PACKAGE}@${targetVersion}`)
  info(`3. re-verify${options.skipLive ? '' : ' (offline suite + live agent turn)'}`)
  info(options.keep ? '4. leave the target in place on failure (--keep)' : `4. roll back to ${before} on failure`)
  process.exit(0)
}

// 1. Baseline. A machine that is already broken must not be blamed on the
//    upgrade, and a rollback target is only meaningful if it was good.
step(`1. Baseline on installed ${before}`)
const baselineOffline = verifyOffline('baseline')
const baselineLive = baselineOffline ? verifyLive('baseline') : 'failed'
if (!baselineOffline || baselineLive === 'failed') {
  fail('baseline verification failed; fix this before upgrading')
  process.exit(1)
}
if (baselineLive === 'skipped') info('baseline live turn skipped; the upgrade check will be offline-only')

// 2. Install.
step(`2. Install ${targetVersion}`)
if (targetVersion === before) {
  info('already installed; nothing to change')
} else if (!install(targetVersion)) {
  fail(`install failed; ${before} is still installed and unaffected`)
  process.exit(1)
} else {
  pass(`installed ${targetVersion}`)
}

// 3. Verify the target.
step(`3. Verify ${PLUGIN_NAME} against ${targetVersion}`)
const upgradedOffline = verifyOffline('target')
const upgradedLive = upgradedOffline ? verifyLive('target') : 'failed'
const upgraded = upgradedOffline && upgradedLive !== 'failed'

if (upgraded) {
  step(`Result: ${PLUGIN_NAME} works on ${targetVersion}`)
  if (upgradedLive === 'skipped') warn('live turn was skipped; only the offline suite was checked')
  const direction = beforeParsed !== undefined
    && targetParsed !== undefined
    && compareVersions(targetParsed, beforeParsed) < 0
    ? 'downgraded'
    : 'upgraded'
  pass(before === targetVersion ? 'no version change was needed' : `${direction} ${before} -> ${targetVersion}`)
  console.log('')
  process.exit(0)
}

// 4. Roll back.
fail(`${PLUGIN_NAME} does not work on ${targetVersion}`)
if (options.keep) {
  step(`Leaving ${targetVersion} installed (--keep)`)
  warn(`the plugin is broken on this version; reinstall ${before} to recover:`)
  info(`npm install -g ${HARNESS_PACKAGE}@${before}`)
  process.exit(3)
}

step(`4. Roll back to ${before}`)
if (targetVersion === before) {
  fail('the installed version already failed verification, so there is nothing to roll back to')
  process.exit(3)
}
if (!install(before)) {
  fail('rollback install failed; reinstall manually:')
  info(`npm install -g ${HARNESS_PACKAGE}@${before}`)
  process.exit(3)
}
pass(`reinstalled ${before}`)

const restoredOffline = verifyOffline('restored')
const restoredLive = restoredOffline ? verifyLive('restored') : 'failed'
if (!restoredOffline || restoredLive === 'failed') {
  fail(`rollback completed but ${PLUGIN_NAME} still fails on ${before}`)
  process.exit(3)
}

step(`Result: rolled back to ${before}; ${PLUGIN_NAME} verified working`)
info(`report the ${targetVersion} failure against this plugin, or pin ${before}`)
console.log('')
// Nonzero: the machine is healthy, but the requested upgrade did not happen.
process.exit(2)
