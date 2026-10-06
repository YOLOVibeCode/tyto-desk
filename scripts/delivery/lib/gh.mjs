/**
 * gh, the GitHub CLI, as the delivery scripts run it: argv arrays, an explicit environment that carries the token and
 * nothing else of the caller's, no prompts, and a timeout. The scripts read pull requests through the REST API as
 * data; they never check one out.
 */
import { argvRunner, pickEnv } from "./run.mjs";

/** @typedef {import("./run.mjs").Runner} Runner */
/** @typedef {import("./run.mjs").RunResult} RunResult */

export const GH_TIMEOUT_MS = 60_000;

/** What gh may see of the caller's environment: its token and config, never anything else. */
const GH_ENV = ["PATH", "HOME", "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_CONFIG_DIR", "XDG_CONFIG_HOME", "TMPDIR"];

/**
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function ghEnvFrom(env) {
  return pickEnv(env, GH_ENV, { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", GH_PAGER: "" });
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string[]} [command]
 * @returns {Runner}
 */
export function ghRunner(env, command = ["gh"]) {
  return argvRunner(command, { env: ghEnvFrom(env), timeoutMs: GH_TIMEOUT_MS });
}

/**
 * The HTTP status of a failed gh call, or null. gh names some statuses in its message (`(HTTP 404)`, `HTTP 404:`) and
 * others only by text (`(Conflict)`), so the error body's `status` counts too.
 * @param {RunResult} result
 * @returns {number | null}
 */
export function httpStatus(result) {
  if (result.code === 0) return null;
  // `gh api`: "Not Found (HTTP 404)"; `gh secret list`: "failed to get secrets: HTTP 404: Not Found (…)".
  const named = /\(HTTP (\d{3})\)|\bHTTP (\d{3}):/.exec(result.stderr)?.slice(1).find((code) => code !== undefined);
  if (named !== undefined) return Number(named);
  const body = /^\s*(\{[\s\S]*\})\s*$/.exec(result.stdout)?.[1];
  if (body === undefined) return null;
  try {
    const status = Number(/** @type {{ status?: unknown }} */ (JSON.parse(body)).status);
    return Number.isInteger(status) ? status : null;
  } catch {
    return null;
  }
}

/** @param {RunResult} result */
export function isNotFound(result) {
  return httpStatus(result) === 404;
}

/** A gh call that failed: names the call and its status, never the response body. */
export class GhError extends Error {
  /** @param {string[]} args @param {RunResult} result */
  constructor(args, result) {
    const status = httpStatus(result);
    super(`gh ${args.slice(0, 4).join(" ")} failed${status === null ? ` (exit ${result.code})` : ` (HTTP ${status})`}`);
    this.name = "GhError";
  }
}

/**
 * Runs gh and parses its JSON output.
 * @param {Runner} gh
 * @param {string[]} args
 * @param {{ input?: string }} [options]
 * @returns {Promise<unknown>}
 */
export async function ghJson(gh, args, options = {}) {
  const result = await gh(args, options);
  if (result.code !== 0) throw new GhError(args, result);
  return result.stdout.trim() === "" ? null : JSON.parse(result.stdout);
}

/**
 * Runs gh for its effect; fails on a non-zero exit. Its output is not JSON (`gh pr merge`, `gh release upload`).
 * @param {Runner} gh
 * @param {string[]} args
 * @returns {Promise<string>}
 */
export async function ghOk(gh, args) {
  const result = await gh(args);
  if (result.code !== 0) throw new GhError(args, result);
  return result.stdout;
}

/** A repository path segment, encoded. @param {string} text */
export function segment(text) {
  return encodeURIComponent(text);
}

/** @param {string} path a slash-separated path whose segments are encoded one by one */
export function encodePath(path) {
  return path.split("/").map(segment).join("/");
}

/**
 * The files a pull request changes, renamed files under both names, and how many entries the API listed. The API
 * lists at most 3,000 files, so callers compare `listed` with the pull request's `changed_files`.
 * @param {Runner} gh
 * @param {string} repository `owner/name`
 * @param {number} number
 * @returns {Promise<{ files: string[]; listed: number }>}
 */
export async function pullRequestFiles(gh, repository, number) {
  const pages = await ghJson(gh, [
    "api",
    "--method",
    "GET",
    "--paginate",
    "--slurp",
    `repos/${repository}/pulls/${number}/files?per_page=100`,
  ]);
  const entries = Array.isArray(pages) ? pages.flat() : [];
  /** @type {Set<string>} */
  const files = new Set();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const { filename, previous_filename: previous } = /** @type {{ filename?: unknown; previous_filename?: unknown }} */ (entry);
    if (typeof filename === "string") files.add(filename);
    if (typeof previous === "string") files.add(previous);
  }
  return { files: [...files].sort(), listed: entries.length };
}
