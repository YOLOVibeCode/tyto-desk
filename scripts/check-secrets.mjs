#!/usr/bin/env node
/**
 * secrets:scan — fail when a file in the checkout looks like it holds a live secret. Code, docs and tests are all
 * scanned; no path is allowlisted. Prints file and rule names, never the matched values.
 * With --staged (the pre-commit hook) it scans what the commit will hold: each staged file's blob in the index, not
 * the working tree, which `git add -p` or an edit after `git add` can make differ.
 * Usage: node scripts/check-secrets.mjs [--root <checkout>] [--staged]
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { secretRules } from "./lib/secrets.mjs";

const at = process.argv.indexOf("--root");
const root = resolve(at > 0 ? (process.argv[at + 1] ?? ".") : ".");
const staged = process.argv.includes("--staged");

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", "test-results"]);

/** A gitlink (submodule) is a commit, not file content. */
const GITLINK_MODE = "160000";

/** @typedef {{ file: string; text: string | null }} Source `text` is null for a binary file. */

/** @param {string[]} args */
function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** @param {Buffer} bytes @returns {string | null} */
function textOf(bytes) {
  return bytes.includes(0) ? null : bytes.toString("utf8");
}

/** @param {string} dir @returns {Promise<string[]>} */
async function walk(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files;
}

/** Tracked and untracked-but-not-ignored files from the working tree; every file when this is not a git checkout. */
async function workingTreeSources() {
  const files = existsSync(join(root, ".git"))
    ? git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)
    : await walk(root);
  /** @type {Source[]} */
  const sources = [];
  for (const file of files) {
    const path = join(root, file);
    if (!existsSync(path) || !(await stat(path)).isFile()) continue;
    sources.push({ file, text: textOf(await readFile(path)) });
  }
  return sources;
}

/**
 * The index's blob of every file the commit adds, copies, modifies, renames or changes in type (a symlink replaced by
 * a file is a type change). Paths and blob ids come from git; the blobs are read by id, never from the working tree.
 */
function stagedSources() {
  const changed = new Set(
    git(["diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z"]).split("\0").filter(Boolean),
  );
  /** @type {Source[]} */
  const sources = [];
  for (const record of git(["ls-files", "--stage", "-z"]).split("\0")) {
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [mode, blob, stage] = record.slice(0, tab).split(" ");
    const file = record.slice(tab + 1);
    if (!changed.has(file) || stage !== "0" || mode === GITLINK_MODE || blob === undefined) continue;
    const bytes = execFileSync("git", ["cat-file", "blob", blob], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    sources.push({ file, text: textOf(bytes) });
  }
  return sources;
}

const findings = [];
for (const { file, text } of staged ? stagedSources() : await workingTreeSources()) {
  if (text === null) continue;
  for (const rule of secretRules(text)) findings.push(`  ${file}  [${rule}]`);
}

if (findings.length > 0) {
  console.error("Secret scan failed. Files and rules (values are never printed):");
  for (const finding of findings) console.error(finding);
  console.error("Remove the secret (keep real ones in 1Password and a gitignored .env) and rotate it if it was ever pushed.");
  process.exit(1);
}
console.log("Secret scan: clean");
