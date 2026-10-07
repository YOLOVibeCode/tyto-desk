/**
 * Owner-merge paths (docs/IMPLEMENTATION.md §23.1, D50, D82): `scripts/delivery/owner-paths.json`, always read from the
 * base branch. owner-merge labels a pull request that touches one, change detection never calls one docs-only, and
 * Dependabot's auto-merge refuses one. Dependency-free: Node only.
 */
import { readFile } from "node:fs/promises";

/** @typedef {{ paths: string[]; branches: string[] }} OwnerPaths */

/** owner-paths.json, beside the delivery scripts. */
export const OWNER_PATHS_FILE = new URL("../owner-paths.json", import.meta.url);

/**
 * Whether `path` falls under `pattern`'s segments. A `**` segment stands for any number of directories, none
 * included; every other segment is a name, matched whole.
 * @param {readonly string[]} pattern
 * @param {readonly string[]} path
 * @returns {boolean}
 */
function matches(pattern, path) {
  const [head, ...rest] = pattern;
  if (head === undefined) return path.length === 0;
  if (head === "**") {
    for (let skip = 0; skip <= path.length; skip += 1) if (matches(rest, path.slice(skip))) return true;
    return false;
  }
  return path[0] === head && matches(rest, path.slice(1));
}

/**
 * A name as the owner-merge match compares it: NFKC-normalized, then lowercased. macOS's file system ignores case, and
 * folds more than ASCII's: `AGENTſ.md` (U+017F, the long s) opens `AGENTS.md` there, and `claude.md` opens `CLAUDE.md`.
 * NFKC folds such letters, and other compatibility forms (the Kelvin sign, ligatures, fullwidth letters), to the plain
 * letters they stand for, so every spelling that may open an agent rule matches it; a name that only looks like one
 * counts too, which fails closed.
 * @param {string} name
 * @returns {string}
 */
export function foldName(name) {
  return name.normalize("NFKC").toLowerCase();
}

/**
 * The owner-merge pattern `path` falls under, or null. Patterns are slash-separated names in which a `**` segment
 * stands for any number of directories: `dir/**` is everything under dir, a leading `**` segment puts a name at any
 * depth, the root included (Claude Code, Cursor and Codex read a nested CLAUDE.md, AGENTS.md or .claude/ too), and any
 * other pattern is one file. Path and patterns compare folded (foldName), as macOS reads names.
 * @param {string} path a repository-relative path, as the API lists it
 * @param {readonly string[]} patterns
 * @returns {string | null}
 */
export function ownerPathOf(path, patterns) {
  const segments = foldName(path).split("/");
  for (const pattern of patterns) {
    if (matches(foldName(pattern).split("/"), segments)) return pattern;
  }
  return null;
}

/**
 * Reads owner-paths.json and refuses one that is not a non-empty list of paths and a list of branches, so a broken file
 * stops the script that reads it instead of matching nothing.
 * @param {URL} [file]
 * @returns {Promise<OwnerPaths>}
 */
export async function readOwnerPaths(file = OWNER_PATHS_FILE) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`owner-paths.json cannot be read: ${err instanceof Error ? err.name : "error"}`);
  }
  const { paths, branches } = /** @type {{ paths?: unknown; branches?: unknown }} */ (parsed ?? {});
  const texts = (/** @type {unknown} */ list) => Array.isArray(list) && list.every((item) => typeof item === "string" && item !== "");
  if (!texts(paths) || !Array.isArray(paths) || paths.length === 0 || !texts(branches)) {
    throw new Error("owner-paths.json needs a non-empty list of paths and a list of branches");
  }
  return { paths: /** @type {string[]} */ (paths), branches: /** @type {string[]} */ (branches) };
}
