/**
 * Change detection for `ci.yml` (docs/IMPLEMENTATION.md §18, §23.7): a pull request is docs-only when every file it
 * touches is under `docs/`, a root Markdown file other than `CLAUDE.md` and `AGENTS.md`, or `LICENSE`; anything else,
 * agent rules and package files included, is code. `ci.yml` runs the base commit's copy, and when in doubt it says
 * code.
 */
import { pullRequestFiles } from "./gh.mjs";

/** @typedef {import("./run.mjs").Runner} Runner */

/** Root Markdown that agents obey, so it is code. Compared without case: macOS reads `claude.md` as `CLAUDE.md`. */
const AGENT_RULES = new Set(["claude.md", "agents.md"]);

/** @param {string} path a repository-relative path */
export function isDocsOnlyPath(path) {
  if (path.startsWith("docs/") || path === "LICENSE") return true;
  return !path.includes("/") && path.endsWith(".md") && !AGENT_RULES.has(path.toLowerCase());
}

/**
 * Whether the files call for the build jobs. No files, or fewer listed than the pull request changes (the API stops at
 * 3,000), is code.
 * @param {string[]} files
 * @param {{ listed: number; expected: number | null }} counts
 * @returns {{ code: boolean }}
 */
export function classifyChanges(files, { listed, expected }) {
  if (files.length === 0 || (expected !== null && listed < expected)) return { code: true };
  return { code: !files.every(isDocsOnlyPath) };
}

/**
 * @param {Runner} gh
 * @param {{ repository: string; number: number; changedFiles: number | null }} pr
 * @returns {Promise<{ code: boolean }>}
 */
export async function pullRequestChanges(gh, { repository, number, changedFiles }) {
  const { files, listed } = await pullRequestFiles(gh, repository, number);
  return classifyChanges(files, { listed, expected: changedFiles });
}
