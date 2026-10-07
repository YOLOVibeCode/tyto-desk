/**
 * The PR check (docs/IMPLEMENTATION.md §23.1, §23.7): the title is a Conventional Commit, the head branch follows the
 * naming scheme, and the pull request's workflow files keep `main`'s workflow rules, with every pinned SHA the commit
 * its tag names. `main`'s `pr-title` job runs `main`'s copy of this on `pull_request_target`, reading the pull request
 * through the API as data; agents run it on a title and branch before `gh pr create`.
 */
import { GhError, encodePath, httpStatus, isNotFound } from "./gh.mjs";
import { RELEASE_BRANCH } from "./release-branch.mjs";
import { actionPins, checkWorkflows } from "./workflow-rules.mjs";

/** @typedef {import("./run.mjs").Runner} Runner */
/** @typedef {import("./workflow-rules.mjs").WorkflowFile} WorkflowFile */

export const TYPES = ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore", "revert"];
export const TITLE_MAX = 72;
/** A tag of a tag of … a commit: more levels than this is no pin anyone writes. */
const MAX_TAG_DEPTH = 5;

/**
 * What one run of the check reads (D85). `pr-title` runs on `pull_request_target`, on fork pull requests too, with the
 * repository's `GITHUB_TOKEN`, whose REST quota (1,000 requests an hour) every workflow shares, so the check reads at
 * most 25 workflow files and looks up at most 25 distinct pins (action and tag), each a ref and up to five peels:
 * at most 1 + 25 + 25 × 6 = 176 requests. Above either cap it fails closed, reading or looking up none of them.
 */
export const MAX_WORKFLOW_FILES = 25;
export const MAX_PINS = 25;
/** The contents API lists at most this many entries of a directory, so a listing this long may be missing some. */
export const LISTING_LIMIT = 1000;

const TITLE = new RegExp(`^(?:${TYPES.join("|")})(?:\\(([a-z0-9-]+)\\))?!?: \\S`);
const SLICE_BRANCH = /^slice-([a-z0-9]+)\/[a-z0-9-]{1,50}$/;
const PEOPLE_BRANCH = /^(?:feat|fix|docs|ci|chore)\/[a-z0-9-]{1,50}$/;
const DEPENDABOT_BRANCH = /^dependabot\/[A-Za-z0-9_.\/-]+$/;

/**
 * The problems with a pull request's title and head branch; none means it passes. A fork's branch is outside the
 * scheme by nature (`patch-1`, even `main`), so only its title is checked, by the rules for people. The bots' branches
 * in this repository have their titles checked for type and scope only: Dependabot's run past 72 characters.
 * @param {{ title: string; branch: string; fork: boolean }} pr
 * @returns {string[]}
 */
export function checkTitleAndBranch({ title, branch, fork }) {
  /** @type {string[]} */
  const problems = [];
  const bot = !fork && (branch === RELEASE_BRANCH || DEPENDABOT_BRANCH.test(branch));
  const match = TITLE.exec(title);
  if (match === null) {
    problems.push(
      `the title is not a Conventional Commit: type(scope)!: subject, with a lowercase type from ${TYPES.join(", ")}`,
    );
  }
  if (!bot) {
    if (title.endsWith(".")) problems.push("the title ends with a period");
    if (title.length > TITLE_MAX) problems.push(`the title is longer than ${TITLE_MAX} characters`);
  }
  if (fork || bot) return problems;
  const slice = SLICE_BRANCH.exec(branch);
  if (slice !== null) {
    const scope = `slice-${slice[1]}`;
    if (match !== null && match[1] !== scope) problems.push(`a ${scope}/… branch's title has the scope (${scope})`);
  } else if (!PEOPLE_BRANCH.test(branch)) {
    problems.push(`the branch ${branch} is outside the naming scheme (CONTRIBUTING)`);
  }
  return problems;
}

/**
 * Where the PR check reads a pull request's head: the workflow directory's listing (the workflow files' paths, and how
 * many entries the API listed), each workflow file, and the commit an action's tag names.
 * @typedef {{
 *   workflowPaths(): Promise<{ paths: string[]; entries: number }>;
 *   workflowText(path: string): Promise<string>;
 *   tagCommit(repo: string, tag: string): Promise<string | null>;
 * }} PullRequestSource
 */

/**
 * A git object as the REST API names one: `{ type, sha }`, or null for anything else.
 * @param {unknown} value
 * @returns {{ type: string; sha: string } | null}
 */
function gitObject(value) {
  const object = /** @type {{ object?: { type?: unknown; sha?: unknown } } | null} */ (value)?.object;
  return typeof object?.type === "string" && typeof object.sha === "string" ? { type: object.type, sha: object.sha } : null;
}

/**
 * The pull request's head through the REST API, as data: the workflow directory and each file at the head commit, and
 * each pinned action's tag as a git ref (`git/ref/tags/<tag>`, peeling an annotated tag through `git/tags/<sha>`), so a
 * branch or an abbreviated commit in the comment never counts as a tag. Nothing is checked out.
 * @param {Runner} gh
 * @param {{ repository: string; headSha: string }} pr
 * @returns {PullRequestSource}
 */
export function ghPullRequestSource(gh, { repository, headSha }) {
  return {
    async workflowPaths() {
      const list = await gh(["api", "--method", "GET", `repos/${repository}/contents/.github/workflows?ref=${headSha}`]);
      if (isNotFound(list)) return { paths: [], entries: 0 };
      if (list.code !== 0) throw new GhError(["api", "contents/.github/workflows"], list);
      const parsed = JSON.parse(list.stdout);
      const entries = Array.isArray(parsed) ? parsed : [];
      /** @type {string[]} */
      const paths = [];
      for (const entry of entries) {
        const { name, path, type } = /** @type {{ name?: unknown; path?: unknown; type?: unknown }} */ (entry ?? {});
        if (type !== "file" || typeof name !== "string" || typeof path !== "string" || !/\.ya?ml$/.test(name)) continue;
        paths.push(path);
      }
      return { paths: paths.sort((a, b) => a.localeCompare(b)), entries: entries.length };
    },
    async workflowText(path) {
      const args = [
        "api",
        "--method",
        "GET",
        "-H",
        "Accept: application/vnd.github.raw",
        `repos/${repository}/contents/${encodePath(path)}?ref=${headSha}`,
      ];
      const file = await gh(args);
      if (file.code !== 0) throw new GhError(args, file);
      return file.stdout;
    },
    async tagCommit(repo, tag) {
      const ref = ["api", "--method", "GET", `repos/${encodePath(repo)}/git/ref/tags/${encodePath(tag)}`];
      const result = await gh(ref);
      if (result.code !== 0) {
        if (isNotFound(result) || httpStatus(result) === 422) return null;
        throw new GhError(ref, result);
      }
      let object = gitObject(JSON.parse(result.stdout));
      for (let depth = 0; object?.type === "tag" && depth < MAX_TAG_DEPTH; depth += 1) {
        if (!/^[0-9a-f]{40}$/.test(object.sha)) return null;
        const peel = ["api", "--method", "GET", `repos/${encodePath(repo)}/git/tags/${object.sha}`];
        const annotated = await gh(peel);
        if (annotated.code !== 0) throw new GhError(peel, annotated);
        object = gitObject(JSON.parse(annotated.stdout));
      }
      return object?.type === "commit" && /^[0-9a-f]{40}$/.test(object.sha) ? object.sha : null;
    },
  };
}

/**
 * Applies the workflow rules to the pull request's workflow files and checks each pinned SHA against its tag, within
 * the caps (MAX_WORKFLOW_FILES, MAX_PINS): above one, or when the listing may be cut short, it fails closed.
 * @param {PullRequestSource} source
 * @returns {Promise<string[]>} one line per problem: `file:line  [rule] detail`
 */
export async function checkWorkflowFiles(source) {
  const cap = ".github/workflows  [cap]";
  const { paths, entries } = await source.workflowPaths();
  if (entries >= LISTING_LIMIT) {
    return [
      `${cap} the API listed ${entries} entries of .github/workflows, the most it lists, so a workflow may be missing; the PR check fails closed`,
    ];
  }
  if (paths.length > MAX_WORKFLOW_FILES) {
    return [`${cap} the head has ${paths.length} workflow files; the PR check reads at most ${MAX_WORKFLOW_FILES}, so it fails closed`];
  }
  /** @type {WorkflowFile[]} */
  const files = [];
  for (const path of paths) files.push({ path, text: await source.workflowText(path) });
  const problems = checkWorkflows(files).map((v) => `${v.file}:${v.line ?? "?"}  [${v.rule}] ${v.detail}`);
  const pins = files.flatMap((file) => actionPins(file.text).map((pin) => ({ file, pin })));
  const distinct = new Set(pins.map(({ pin }) => `${pin.repo}@${pin.tag}`));
  if (distinct.size > MAX_PINS) {
    problems.push(
      `${cap} the workflow files pin ${distinct.size} distinct actions (action and tag); the PR check looks up at most ${MAX_PINS}, so it fails closed`,
    );
    return problems;
  }
  /** @type {Map<string, Promise<string | null>>} */
  const tags = new Map();
  for (const { file, pin } of pins) {
    const key = `${pin.repo}@${pin.tag}`;
    let commit = tags.get(key);
    if (commit === undefined) {
      commit = source.tagCommit(pin.repo, pin.tag);
      tags.set(key, commit);
    }
    const named = await commit;
    const at = `${file.path}:${pin.line ?? "?"}  [pinned-sha]`;
    if (named === null) problems.push(`${at} ${pin.repo} has no tag ${pin.tag}`);
    else if (named !== pin.sha) problems.push(`${at} ${pin.repo}@${pin.sha} is not ${pin.tag}, which names ${named}`);
  }
  return problems;
}
