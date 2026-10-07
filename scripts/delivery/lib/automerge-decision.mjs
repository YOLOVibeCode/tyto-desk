/**
 * Which Dependabot pull requests merge themselves (docs/IMPLEMENTATION.md §23.7, D44): an npm `direct:development`
 * update of `@types/*`, `typescript`, `vitest` or `yaml`, of type `version-update:semver-patch`. A group passes only when
 * every member does. These tools run in tests and type checks, never while the runtime is packed, and nothing they
 * provide ships. Everything else waits for the owner, esbuild above all, which writes every byte Desk ships.
 *
 * And only once `main` requires the checks (the interim rule, D54): with no ruleset requiring `pr-title` and `ci-ok`,
 * `gh pr merge --auto` merges a pull request whose checks are still running or failing at once. Until `github-setup
 * --apply` has run, the owner merges even the allowed class by hand.
 *
 * Dependency-free (Node and gh): `dependabot-auto-merge.yml` runs the base branch's copy on fetch-metadata's output.
 */
import { ghJson } from "./gh.mjs";

/** @typedef {import("./run.mjs").Runner} Runner */
/** @typedef {{ merge: boolean; reason: string }} AutomergeDecision */

const ALLOWED_NAMES = new Set(["typescript", "vitest", "yaml"]);
const ALLOWED_TEXT = "@types/*, typescript, vitest, yaml";

/** The checks `main`'s ruleset requires, and the app they must come from: GitHub Actions (§23.1, §23.2). */
export const REQUIRED_CHECKS = ["pr-title", "ci-ok"];
export const ACTIONS_APP_ID = 15368;

/** A package name as it may appear in a workflow output and a comment: one line, no markup. @param {unknown} name */
export function safeName(name) {
  return String(name).replace(/[^A-Za-z0-9@._/~-]/g, "").slice(0, 214) || "(unnamed)";
}

/** @param {Record<string, unknown>} update */
function allowed(update) {
  const name = update.dependencyName;
  return (
    update.packageEcosystem === "npm_and_yarn" &&
    update.dependencyType === "direct:development" &&
    update.updateType === "version-update:semver-patch" &&
    typeof name === "string" &&
    (ALLOWED_NAMES.has(name) || /^@types\/[a-z0-9._~-]+$/.test(name))
  );
}

/**
 * Whether `main`'s active rules (`GET repos/<r>/rules/branches/main`) require `pr-title` and `ci-ok` from GitHub
 * Actions. Anything else, a rule list that could not be read included, is no.
 * @param {unknown} rules
 * @returns {boolean}
 */
export function mainRequiresChecks(rules) {
  if (!Array.isArray(rules)) return false;
  /** @type {Set<string>} */
  const required = new Set();
  for (const rule of rules) {
    const { type, parameters } = /** @type {{ type?: unknown; parameters?: { required_status_checks?: unknown } }} */ (rule ?? {});
    if (type !== "required_status_checks" || !Array.isArray(parameters?.required_status_checks)) continue;
    for (const check of parameters.required_status_checks) {
      const { context, integration_id: app } = /** @type {{ context?: unknown; integration_id?: unknown }} */ (check ?? {});
      if (typeof context === "string" && app === ACTIONS_APP_ID) required.add(context);
    }
  }
  return REQUIRED_CHECKS.every((check) => required.has(check));
}

/**
 * @param {unknown} updates fetch-metadata's `updated-dependencies-json`, parsed
 * @param {{ checksRequired: boolean }} main whether `main` requires `pr-title` and `ci-ok` (mainRequiresChecks)
 * @returns {AutomergeDecision}
 */
export function automergeDecision(updates, { checksRequired }) {
  if (!Array.isArray(updates) || updates.length === 0) {
    return { merge: false, reason: "Dependabot reported no updated dependency" };
  }
  for (const update of updates) {
    const record = typeof update === "object" && update !== null ? /** @type {Record<string, unknown>} */ (update) : {};
    if (!allowed(record)) {
      return {
        merge: false,
        reason: `${safeName(record.dependencyName)} is not a patch update of an allowlisted dev tool (${ALLOWED_TEXT})`,
      };
    }
  }
  if (!checksRequired) {
    return {
      merge: false,
      reason:
        "main does not require pr-title and ci-ok yet, so auto-merge would not wait for them (the interim rule, D54: github-setup --apply has not run)",
    };
  }
  return { merge: true, reason: "patch updates of allowlisted dev tools" };
}

/**
 * The decision for one Dependabot pull request: the update class first, then, only for an update it would merge,
 * `main`'s active rules through the API (read-only). A failed read counts as rules that require nothing.
 * @param {Runner} gh
 * @param {{ repository: string; updates: unknown }} input
 * @returns {Promise<AutomergeDecision>}
 */
export async function decideAutomerge(gh, { repository, updates }) {
  const byClass = automergeDecision(updates, { checksRequired: true });
  if (!byClass.merge) return byClass;
  /** @type {unknown} */
  let rules = null;
  try {
    const pages = await ghJson(gh, [
      "api",
      "--method",
      "GET",
      "--paginate",
      "--slurp",
      `repos/${repository}/rules/branches/main?per_page=100`,
    ]);
    rules = Array.isArray(pages) ? pages.flat() : null;
  } catch {
    rules = null;
  }
  return automergeDecision(updates, { checksRequired: mainRequiresChecks(rules) });
}
