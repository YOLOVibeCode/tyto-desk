/**
 * The PR check (docs/IMPLEMENTATION.md §23.1, §23.7): the title is a Conventional Commit, the head branch follows the
 * naming scheme, and the pull request's workflow files keep `main`'s workflow rules, with every pinned SHA the commit
 * its tag names. `main`'s `pr-title` job runs `main`'s copy of this on `pull_request_target`, reading the pull request
 * through the API as data; agents run it on a title and branch before `gh pr create`.
 */
import { GhError, encodePath, httpStatus, isNotFound } from "./gh.mjs";
import { actionPins, checkWorkflows } from "./workflow-rules.mjs";

/** @typedef {import("./run.mjs").Runner} Runner */
/** @typedef {import("./workflow-rules.mjs").WorkflowFile} WorkflowFile */

export const TYPES = ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore", "revert"];
export const TITLE_MAX = 72;
export const RELEASE_BRANCH = "release-please--branches--main";

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
 * Where the PR check reads a pull request's head: its workflow files, and the commit an action's tag names.
 * @typedef {{
 *   workflowFiles(): Promise<WorkflowFile[]>;
 *   tagCommit(repo: string, tag: string): Promise<string | null>;
 * }} PullRequestSource
 */

/**
 * The pull request's head through the REST API, as data: the workflow directory and each file at the head commit, and
 * `commits/<tag>` for each pinned action. Nothing is checked out.
 * @param {Runner} gh
 * @param {{ repository: string; headSha: string }} pr
 * @returns {PullRequestSource}
 */
export function ghPullRequestSource(gh, { repository, headSha }) {
  return {
    async workflowFiles() {
      const list = await gh(["api", "--method", "GET", `repos/${repository}/contents/.github/workflows?ref=${headSha}`]);
      if (isNotFound(list)) return [];
      if (list.code !== 0) throw new GhError(["api", "contents/.github/workflows"], list);
      const entries = JSON.parse(list.stdout);
      /** @type {WorkflowFile[]} */
      const files = [];
      for (const entry of Array.isArray(entries) ? entries : []) {
        const { name, path, type } = /** @type {{ name?: unknown; path?: unknown; type?: unknown }} */ (entry ?? {});
        if (type !== "file" || typeof name !== "string" || typeof path !== "string" || !/\.ya?ml$/.test(name)) continue;
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
        files.push({ path, text: file.stdout });
      }
      return files.sort((a, b) => a.path.localeCompare(b.path));
    },
    async tagCommit(repo, tag) {
      const args = ["api", "--method", "GET", `repos/${encodePath(repo)}/commits/${encodeURIComponent(tag)}`, "--jq", ".sha"];
      const result = await gh(args);
      if (result.code !== 0) {
        if (isNotFound(result) || httpStatus(result) === 422) return null;
        throw new GhError(args, result);
      }
      const sha = result.stdout.trim();
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    },
  };
}

/**
 * Applies the workflow rules to the pull request's workflow files and checks each pinned SHA against its tag.
 * @param {PullRequestSource} source
 * @returns {Promise<string[]>} one line per problem: `file:line  [rule] detail`
 */
export async function checkWorkflowFiles(source) {
  const files = await source.workflowFiles();
  const problems = checkWorkflows(files).map((v) => `${v.file}:${v.line ?? "?"}  [${v.rule}] ${v.detail}`);
  /** @type {Map<string, Promise<string | null>>} */
  const tags = new Map();
  for (const file of files) {
    for (const pin of actionPins(file.text)) {
      const key = `${pin.repo}@${pin.tag}`;
      let commit = tags.get(key);
      if (commit === undefined) {
        commit = source.tagCommit(pin.repo, pin.tag);
        tags.set(key, commit);
      }
      const named = await commit;
      const where = `${file.path}:${pin.line ?? "?"}  [pinned-sha]`;
      if (named === null) problems.push(`${where} ${pin.repo} has no tag ${pin.tag}`);
      else if (named !== pin.sha) problems.push(`${where} ${pin.repo}@${pin.sha} is not ${pin.tag}, which names ${named}`);
    }
  }
  return problems;
}
