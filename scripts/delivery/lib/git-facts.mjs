/**
 * The git facts the stamp gathers (docs/IMPLEMENTATION.md §23.3): the commit, whether the tree is dirty, the branch,
 * and whether a tag is on `main`. Every call is git with an argv array and a timeout; any git error is an answer
 * (no commit, not on main), never a guess.
 */
import { argvRunner, pickEnv } from "./run.mjs";

/** @typedef {import("./run.mjs").Runner} Runner */

export const GIT_TIMEOUT_MS = 30_000;
export const FETCH_TIMEOUT_MS = 120_000;

/** What git may see of the caller's environment: enough to find itself and its configuration, never a token. */
const GIT_ENV = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CEILING_DIRECTORIES",
];

/**
 * git's environment from `env`: an allowlist, no prompts, and plain C-locale output.
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function gitEnvFrom(env) {
  return pickEnv(env, GIT_ENV, { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });
}

/**
 * @param {{ cwd: string; env: Record<string, string>; command?: string[] }} options `env` is used as given
 * @returns {Runner}
 */
export function gitRunner({ cwd, env, command = ["git"] }) {
  return argvRunner(command, { cwd, env, timeoutMs: GIT_TIMEOUT_MS });
}

/**
 * `git rev-parse HEAD`, or `null` when there is no 40-hex commit (not a git checkout).
 * @param {Runner} git
 * @returns {Promise<string | null>}
 */
export async function headCommit(git) {
  const result = await git(["rev-parse", "HEAD"]);
  const sha = result.stdout.trim();
  return result.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * The checked-out branch, or `null` when HEAD is detached.
 * @param {Runner} git
 * @returns {Promise<string | null>}
 */
export async function currentBranch(git) {
  const result = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = result.stdout.trim();
  return result.code === 0 && branch !== "" ? branch : null;
}

/**
 * Paths with tracked changes (staged or not) and untracked files that are not ignored, sorted; `null` when git could
 * not tell, which the stamp treats as dirty.
 * @param {Runner} git
 * @returns {Promise<string[] | null>}
 */
export async function dirtyFiles(git) {
  const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=no"]);
  const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"]);
  if (status.code !== 0 || untracked.code !== 0) return null;
  const files = new Set();
  const records = status.stdout.split("\0");
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i] ?? "";
    if (record.length < 4) continue;
    files.add(record.slice(3));
    // A rename or copy is followed by its source path.
    if (/[RC]/.test(record.slice(0, 2))) {
      i += 1;
      const source = records[i];
      if (source) files.add(source);
    }
  }
  for (const path of untracked.stdout.split("\0")) if (path !== "") files.add(path);
  return [...files].sort();
}

/**
 * Whether `commit` is on `main`: the stamp fetches `main` and asks `merge-base --is-ancestor`. Any git error, a failed
 * fetch included, means not on main.
 * @param {Runner} git
 * @param {string} commit
 * @returns {Promise<boolean>}
 */
export async function tagOnMain(git, commit) {
  const fetch = await git(["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"], {
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (fetch.code !== 0) return false;
  const ancestor = await git(["merge-base", "--is-ancestor", commit, "origin/main"]);
  return ancestor.code === 0;
}
