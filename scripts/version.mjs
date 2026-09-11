/**
 * Version ordering for the upgrade check.
 *
 * dsh publishes prereleases (`0.1.5-rc.2`), and its dist-tags are not
 * monotonic — `latest` currently trails `next` — so the upgrade check cannot
 * treat an install target as "newer" without comparing it. This module is kept
 * separate from the script that uses it so the ordering rules can be tested
 * directly: a wrong answer here would silently downgrade a working install.
 *
 * @module dsh-llm-commandcode/version
 */

/**
 * Parse a semver-shaped version, including prereleases.
 *
 * @param {string} text - Version string, with or without a leading `v`.
 * @returns {{major: number, minor: number, patch: number, prerelease: string|undefined}|undefined}
 *   The parsed version, or undefined when the text is not a version.
 */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text).trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  }
}

/**
 * Order two prerelease identifier lists per semver: a numeric identifier is
 * lower than an alphanumeric one, and a shorter list is lower when its prefix
 * matches.
 */
function comparePrerelease(left, right) {
  if (left === right) return 0
  // A version carrying a prerelease is always lower than one without: rc.1 < release.
  if (left === undefined) return 1
  if (right === undefined) return -1
  const leftParts = left.split('.')
  const rightParts = right.split('.')
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const a = leftParts[index]
    const b = rightParts[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      if (Number(a) !== Number(b)) return Number(a) < Number(b) ? -1 : 1
      continue
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/**
 * Compare two parsed versions.
 *
 * @param {object} left - A {@link parseVersion} result.
 * @param {object} right - A {@link parseVersion} result.
 * @returns {number} negative when `left` is older, positive when newer, 0 when equal.
 */
export function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}
