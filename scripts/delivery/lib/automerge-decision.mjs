/**
 * Which Dependabot pull requests merge themselves (docs/IMPLEMENTATION.md §23.7, D44): an npm `direct:development`
 * update of `@types/*`, `typescript`, `vitest` or `yaml`, of type `version-update:semver-patch`. A group passes only when
 * every member does. These tools run in tests and type checks, never while the runtime is packed, and nothing they
 * provide ships. Everything else waits for the owner, esbuild above all, which writes every byte Desk ships.
 *
 * And only Dependabot's own pull request, as the event named it (D83): every commit on it authored by dependabot[bot]
 * and signed by GitHub, its commits ending at the head commit the event named, its head still that commit, and none of
 * its files an owner-merge path (`owner-paths.json`, or a file list the API cut short). The workflow runs only on events
 * Dependabot sent and turns auto-merge on only while the head is that commit (`--match-head-commit`), so a push by
 * anyone else never turns auto-merge on; a later push that touches an owner-merge path turns it off (owner-merge.yml).
 *
 * And only once `main` requires the checks (the interim rule, D54): with no ruleset requiring `pr-title` and `ci-ok`,
 * `gh pr merge --auto` merges a pull request whose checks are still running or failing at once. Until `github-setup
 * --apply` has run, the owner merges even the allowed class by hand.
 *
 * Dependency-free (Node and gh): `dependabot-auto-merge.yml` runs the base branch's copy on fetch-metadata's output.
 */
import { ghJson, pullRequestFiles } from "./gh.mjs";
import { ownerMergeDecision } from "./owner-merge.mjs";

/** @typedef {import("./run.mjs").Runner} Runner */
/** @typedef {{ merge: boolean; reason: string }} AutomergeDecision */

const ALLOWED_NAMES = new Set(["typescript", "vitest", "yaml"]);
const ALLOWED_TEXT = "@types/*, typescript, vitest, yaml";

/** Dependabot's account: the author of every commit on a pull request that merges itself. */
export const DEPENDABOT = "dependabot[bot]";

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

/** A commit as one line may name it: its first seven hex digits, or "(unknown)". @param {unknown} sha */
function shortSha(sha) {
  return typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : "(unknown)";
}

/**
 * Why a Dependabot pull request may not merge itself, judged from what the API reported about it, or null. It must
 * still be at the head commit the event named, with every commit listed, the list ending at that head, and each commit
 * authored by dependabot[bot] and signed by GitHub (`verification.verified`; a forged author email is never signed);
 * and none of its files may be an owner-merge path.
 * @param {{ headSha: string; pull: unknown; commits: readonly unknown[]; files: string[]; listed: number; ownerPaths: string[] }} pr
 *   `pull` is `GET repos/<r>/pulls/<n>`, `commits` its commit list, `files` and `listed` its file list (pullRequestFiles)
 * @returns {string | null}
 */
export function pullRequestRefusal({ headSha, pull, commits, files, listed, ownerPaths }) {
  const { head, commits: count, changed_files: changedFiles } =
    /** @type {{ head?: { sha?: unknown }; commits?: unknown; changed_files?: unknown }} */ (pull ?? {});
  if (head?.sha !== headSha) return "its head moved after the event";
  if (typeof count !== "number") return "the API did not say how many commits it has";
  if (commits.length < count) return `the API listed only ${commits.length} of its ${count} commits`;
  const last = /** @type {{ sha?: unknown } | undefined} */ (commits.at(-1));
  if (last?.sha !== headSha) return "its commits do not end at the head commit the event named";
  for (const entry of commits) {
    const { sha, author, commit } =
      /** @type {{ sha?: unknown; author?: { login?: unknown } | null; commit?: { verification?: { verified?: unknown } } }} */ (
        entry ?? {}
      );
    if (author?.login !== DEPENDABOT || commit?.verification?.verified !== true) {
      return `commit ${shortSha(sha)} is not Dependabot's`;
    }
  }
  const owner = ownerMergeDecision({
    files,
    headRef: "",
    config: { paths: ownerPaths, branches: [] },
    listed,
    changedFiles: typeof changedFiles === "number" ? changedFiles : null,
  });
  return owner.ownerMerge ? `it is owner-merge (${owner.reasons.join(", ")})` : null;
}

/**
 * The decision for one Dependabot pull request: the update class first; then, only for an update it would merge, the
 * pull request itself (pullRequestRefusal) and `main`'s active rules, through the API (read-only). A pull request that
 * cannot be read is refused; rules that cannot be read count as rules that require nothing.
 * @param {Runner} gh
 * @param {{ repository: string; number: number; headSha: string; updates: unknown; ownerPaths: string[] }} input
 *   `number` and `headSha` are the pull request and the head commit the event named
 * @returns {Promise<AutomergeDecision>}
 */
export async function decideAutomerge(gh, { repository, number, headSha, updates, ownerPaths }) {
  const byClass = automergeDecision(updates, { checksRequired: true });
  if (!byClass.merge) return byClass;
  if (repository === "" || !Number.isSafeInteger(number) || number < 1 || !/^[0-9a-f]{40}$/.test(headSha)) {
    return { merge: false, reason: "the workflow named no pull request and head commit (REPOSITORY, PR_NUMBER, PR_HEAD_SHA)" };
  }
  /** @type {string | null} */
  let refusal;
  try {
    // The lists first, then the pull request: a push in between shows as a moved head.
    const pages = await ghJson(gh, [
      "api",
      "--method",
      "GET",
      "--paginate",
      "--slurp",
      `repos/${repository}/pulls/${number}/commits?per_page=100`,
    ]);
    const commits = Array.isArray(pages) ? pages.flat() : [];
    const { files, listed } = await pullRequestFiles(gh, repository, number);
    const pull = await ghJson(gh, ["api", "--method", "GET", `repos/${repository}/pulls/${number}`]);
    refusal = pullRequestRefusal({ headSha, pull, commits, files, listed, ownerPaths });
  } catch {
    return { merge: false, reason: "the pull request's commits, files or head could not be read" };
  }
  if (refusal !== null) return { merge: false, reason: refusal };
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
