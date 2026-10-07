/**
 * The stamp (docs/IMPLEMENTATION.md §23.3–23.4): gathers what a build is from git and, in CI, from GitHub's event
 * payload and `GITHUB_*` variables; core's `classifyBuild` decides; the stamp writes `version.json` into the build
 * output, never into the repository. `npm run pack`, `npm run deploy` and every CI build job run it.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DESK_COMPAT } from "../../../packages/core/src/release/compat.ts";
import { currentBranch, dirtyFiles, headCommit, tagOnMain } from "./git-facts.mjs";
import { readNodeRuntime } from "./node-runtime.mjs";

/** @typedef {import("./run.mjs").Runner} Runner */
/** @typedef {import("../../../packages/core/src/release/classify-build.ts").ClassifyBuildInput} ClassifyBuildInput */
/** @typedef {import("../../../packages/core/src/release/classify-build.ts").BuildClassification} BuildClassification */

/**
 * @typedef {{
 *   input: ClassifyBuildInput;
 *   dirtyFiles: string[] | null;
 *   problems: string[];
 * }} BuildFacts
 */

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  return typeof value === "object" && value !== null ? /** @type {Record<string, unknown>} */ (value) : {};
}

/** @param {string | undefined} text @returns {number | null} */
function integer(text) {
  if (text === undefined || !/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/** `2026-10-06T18:00:00Z`: UTC to the second. @param {Date} date */
export function isoSeconds(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** @param {string} root @returns {Promise<string>} the root package.json's version, or "" */
async function baseVersionOf(root) {
  const manifest = record(JSON.parse(await readFile(join(root, "package.json"), "utf8")));
  return typeof manifest.version === "string" ? manifest.version : "";
}

/**
 * The pull request in the event payload: its number, head commit, head branch, and whether the head repository is
 * another one (a deleted fork's is null, so it counts as a fork).
 * @param {Record<string, string | undefined>} env
 */
async function pullRequestFromEvent(env) {
  const path = env.GITHUB_EVENT_PATH;
  if (path === undefined) throw new Error("GITHUB_EVENT_PATH is not set for a pull_request build");
  const event = record(JSON.parse(await readFile(path, "utf8")));
  const pr = record(event.pull_request);
  const head = record(pr.head);
  const headRepo = head.repo === null ? null : record(head.repo);
  const number = typeof pr.number === "number" ? pr.number : null;
  return {
    number,
    sha: typeof head.sha === "string" ? head.sha : null,
    branch: typeof head.ref === "string" ? head.ref : null,
    fork: headRepo === null || headRepo.full_name !== env.GITHUB_REPOSITORY,
  };
}

/**
 * Gathers `classifyBuild`'s input. `problems` names facts that contradict each other, such as a pull request build
 * whose checkout is not the pull request's head commit.
 * @param {{
 *   root: string;
 *   env: Record<string, string | undefined>;
 *   git: Runner;
 *   now: () => Date;
 *   allowDirty: boolean;
 *   dryRun: boolean;
 * }} options
 * @returns {Promise<BuildFacts>}
 */
export async function gatherBuildFacts({ root, env, git, now, allowDirty, dryRun }) {
  /** @type {string[]} */
  const problems = [];
  const ci = env.GITHUB_ACTIONS === "true";
  const head = await headCommit(git);
  const dirty = await dirtyFiles(git);
  const baseVersion = await baseVersionOf(root);
  const builtAt = isoSeconds(now());
  const common = { dirty: dirty === null || dirty.length > 0, allowDirty, dryRun, baseVersion, builtAt };

  if (!ci) {
    const branch = await currentBranch(git);
    return {
      input: {
        ...common,
        event: "local",
        ref: branch === null ? "" : `refs/heads/${branch}`,
        refType: null,
        branch,
        tagOnMain: false,
        sha: head,
        headRepoIsFork: false,
        prNumber: null,
        runNumber: null,
      },
      dirtyFiles: dirty,
      problems,
    };
  }

  const event = env.GITHUB_EVENT_NAME ?? "";
  const ref = env.GITHUB_REF ?? "";
  const refType = env.GITHUB_REF_TYPE === "tag" || env.GITHUB_REF_TYPE === "branch" ? env.GITHUB_REF_TYPE : null;
  const runNumber = integer(env.GITHUB_RUN_NUMBER);
  /** @type {ClassifyBuildInput} */
  const input = {
    ...common,
    event,
    ref,
    refType,
    branch: ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null,
    tagOnMain: false,
    sha: head,
    headRepoIsFork: false,
    prNumber: null,
    runNumber,
  };
  if (event === "pull_request") {
    const pr = await pullRequestFromEvent(env);
    if (pr.sha !== null && head !== null && pr.sha !== head) {
      problems.push(`the checkout is ${head}, not the pull request's head commit ${pr.sha}`);
    }
    return {
      input: { ...input, sha: pr.sha, branch: pr.branch, headRepoIsFork: pr.fork, prNumber: pr.number },
      dirtyFiles: dirty,
      problems,
    };
  }
  if (ref.startsWith("refs/tags/") && head !== null) {
    const onMain = await tagOnMain(git, head);
    return { input: { ...input, tagOnMain: onMain, branch: onMain ? "main" : null }, dirtyFiles: dirty, problems };
  }
  return { input, dirtyFiles: dirty, problems };
}

/**
 * `version.json` (§23.4) for a build `classifyBuild` accepted.
 * @param {ClassifyBuildInput} input
 * @param {Extract<BuildClassification, { ok: true }>} build
 * @param {string} node Desk Terminal's Node version
 */
export function versionFile(input, build, node) {
  return {
    version: build.version,
    channel: build.channel,
    branch: input.branch,
    commit: input.sha,
    dirty: input.dirty,
    builtAt: input.builtAt,
    node,
    compat: DESK_COMPAT,
  };
}

/**
 * Desk Terminal's Node: the version `scripts/delivery/node-runtime.json` pins (D49; `.nvmrc` names the same one, which a
 * test checks).
 * @param {string} root
 */
export async function pinnedNode(root) {
  return (await readNodeRuntime(root)).version;
}

/**
 * Where `version.json` may go: outside the checkout, or inside it only where git ignores it (dist/), so the stamp never
 * writes into the repository.
 * @param {Runner} git
 * @param {string} root
 * @param {string} outDir
 * @returns {Promise<boolean>}
 */
export async function outsideTheRepository(git, root, outDir) {
  const path = relative(resolve(root), join(resolve(root, outDir), "version.json"));
  // Outside means a first segment of `..`; `..cache/version.json` is inside.
  if (path.split(sep)[0] === ".." || isAbsolute(path)) return true;
  const ignored = await git(["check-ignore", "--quiet", "--no-index", "--", path]);
  return ignored.code === 0;
}

/**
 * @param {string} outDir
 * @param {ReturnType<typeof versionFile>} file
 */
export async function writeVersionFile(outDir, file) {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "version.json"), `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * The lines the stamp appends to `GITHUB_OUTPUT`. Every value is a version, an enum, or a label made of
 * `[0-9A-Za-z.+-]`, so none can start another output.
 * @param {Extract<BuildClassification, { ok: true }>} build
 */
export function githubOutput(build) {
  return [
    `version=${build.version}`,
    `channel=${build.channel}`,
    `publish=${build.publish}`,
    `live=${build.live}`,
    `label=${build.label}`,
    "",
  ].join("\n");
}

/** What each refusal means, for the person reading the failed job. */
export const REFUSAL_TEXT = {
  "tag-not-semver": "the tag is not exactly vMAJOR.MINOR.PATCH",
  "tag-not-on-main": "the tagged commit is not on main, or the stamp could not tell",
  "version-mismatch": "the tag's version differs from package.json's",
  "bad-base-version": "package.json's version is not MAJOR.MINOR.PATCH",
  "dirty-tree": "the tree has uncommitted changes",
  "allow-dirty-in-ci": "--allow-dirty is for local builds only",
  "unsupported-ref": "builds come only from main, a v-tag, a pull request, or a checkout",
  "no-commit": "there is no 40-hex commit (not a git checkout?)",
};
