import { compareVersions } from "./semver.ts";

/**
 * The latest-flag rule (docs/IMPLEMENTATION.md §23.8, D55): a release becomes `releases/latest` only when its version
 * sorts at or above every published release's, so re-running an old release's `publish` after a newer one shipped
 * never moves every Mac back. `published` holds the versions of the releases already published, whatever their flags.
 */
export function isLatestRelease(version: string, published: readonly string[]): boolean {
  return published.every((other) => compareVersions(version, other) >= 0);
}
