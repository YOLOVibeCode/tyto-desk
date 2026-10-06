/**
 * `ci-ok`, the one required build check (docs/IMPLEMENTATION.md §23.7). It runs with `if: always()` after `changes`,
 * `scan`, `check` and `macos`, and fails when any of them failed or was cancelled, when `changes` found code and
 * `check` (or, on a pull request, `macos`) did not succeed, or on the release PR while `macos` reports no runtime
 * (D58). A docs-only pull request passes with `check` and `macos` skipped.
 */

export const RELEASE_BRANCH = "release-please--branches--main";
const JOBS = ["changes", "scan", "check", "macos"];
const RESULTS = new Set(["success", "failure", "cancelled", "skipped"]);

/** @typedef {{ result?: unknown; outputs?: Record<string, unknown> }} Need */

/**
 * @param {{ needs: Record<string, Need | undefined>; event: string; headRef: string }} input `needs` is the workflow's
 *   `toJSON(needs)`
 * @returns {{ ok: boolean; reasons: string[] }}
 */
export function ciOk({ needs, event, headRef }) {
  /** @type {string[]} */
  const reasons = [];
  /** @param {string} job */
  const result = (job) => {
    const value = needs[job]?.result;
    return typeof value === "string" ? value : "missing";
  };
  for (const job of JOBS) {
    const value = result(job);
    if (value === "failure") reasons.push(`${job} failed`);
    else if (value === "cancelled") reasons.push(`${job} was cancelled`);
    else if (!RESULTS.has(value)) reasons.push(`${job} reported ${value === "missing" ? "nothing" : value}`);
  }
  if (result("changes") === "skipped") reasons.push("changes was skipped");
  if (result("scan") === "skipped") reasons.push("scan was skipped");
  const code = needs.changes?.outputs?.code === "true";
  const pullRequest = event === "pull_request";
  if (code && result("check") === "skipped") reasons.push("code changed and check did not run");
  if (code && pullRequest && result("macos") === "skipped") reasons.push("code changed and macos did not run");
  if (pullRequest && headRef === RELEASE_BRANCH && needs.macos?.outputs?.runtime !== "true") {
    reasons.push("the release PR has no runtime to release (slice 1c; D58)");
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}
