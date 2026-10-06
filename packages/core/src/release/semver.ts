/**
 * SemVer 2.0.0, as far as Desk's versions need it (docs/IMPLEMENTATION.md §23.3): parsing, precedence, and the two
 * strict shapes Desk accepts as a base version (`MAJOR.MINOR.PATCH`) and as a release tag (`vMAJOR.MINOR.PATCH`).
 */

/** A parsed version. Numeric prerelease identifiers are numbers; build metadata never affects precedence. */
export type Semver = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
  readonly build: readonly string[];
};

const NUMBER = "0|[1-9]\\d*";
const IDENTIFIER = "[0-9A-Za-z-]+";
const SEMVER = new RegExp(
  `^(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(?:\\+(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?$`,
);
const BASE = new RegExp(`^(?:${NUMBER})\\.(?:${NUMBER})\\.(?:${NUMBER})$`);

function safeInteger(text: string): number | null {
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/** Parses a SemVer 2.0.0 version, or returns `null`. No `v` prefix, no leading zeros in numeric identifiers. */
export function parseSemver(text: string): Semver | null {
  const match = SEMVER.exec(text);
  if (match === null) return null;
  const [, majorText = "", minorText = "", patchText = "", pre, build] = match;
  const major = safeInteger(majorText);
  const minor = safeInteger(minorText);
  const patch = safeInteger(patchText);
  if (major === null || minor === null || patch === null) return null;
  const prerelease: (string | number)[] = [];
  for (const id of pre === undefined ? [] : pre.split(".")) {
    if (!/^\d+$/.test(id)) {
      prerelease.push(id);
      continue;
    }
    // A numeric identifier has no leading zero and fits a safe integer.
    const value = safeInteger(id);
    if ((id.length > 1 && id.startsWith("0")) || value === null) return null;
    prerelease.push(value);
  }
  return { major, minor, patch, prerelease, build: build === undefined ? [] : build.split(".") };
}

function sign(n: number): -1 | 0 | 1 {
  return n < 0 ? -1 : n > 0 ? 1 : 0;
}

function compareIdentifiers(a: string | number, b: string | number): -1 | 0 | 1 {
  if (typeof a === "number" && typeof b === "number") return sign(a - b);
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SemVer precedence: -1, 0 or 1. Build metadata is ignored, so `0.3.0+dryrun.12` equals `0.3.0`. */
export function compareSemver(a: Semver, b: Semver): -1 | 0 | 1 {
  const core = sign(a.major - b.major) || sign(a.minor - b.minor) || sign(a.patch - b.patch);
  if (core !== 0) return core;
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return sign(b.prerelease.length - a.prerelease.length);
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const order = compareIdentifiers(x, y);
    if (order !== 0) return order;
  }
  return 0;
}

/** Compares two version strings by SemVer precedence. Passing anything but a SemVer version is a programming error. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (left === null) throw new Error(`${JSON.stringify(a)} is not a SemVer version`);
  if (right === null) throw new Error(`${JSON.stringify(b)} is not a SemVer version`);
  return compareSemver(left, right);
}

/** Whether `text` is exactly `MAJOR.MINOR.PATCH`: the root package.json's version, and every stable version. */
export function isBaseVersion(text: string): boolean {
  return BASE.test(text) && parseSemver(text) !== null;
}

/** The version a release tag names: exactly `vMAJOR.MINOR.PATCH` (lowercase `v`, no prerelease, no leading zeros). */
export function releaseTagVersion(tag: string): string | null {
  if (!tag.startsWith("v")) return null;
  const version = tag.slice(1);
  return isBaseVersion(version) ? version : null;
}
