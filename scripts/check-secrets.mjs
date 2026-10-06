#!/usr/bin/env node
/**
 * secrets:scan — fail when a file in the checkout looks like it holds a live secret. Code, docs and tests are all
 * scanned; no path is allowlisted. Prints file and rule names, never the matched values.
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

/** Tracked and untracked-but-not-ignored files, or only staged ones; every file when this is not a git checkout. */
async function filesToScan() {
  if (!existsSync(join(root, ".git"))) return walk(root);
  const args = staged
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
    : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
}

const findings = [];
for (const file of await filesToScan()) {
  const path = join(root, file);
  if (!existsSync(path) || !(await stat(path)).isFile()) continue;
  const text = await readFile(path, "utf8");
  if (text.includes("\0")) continue;
  for (const rule of secretRules(text)) findings.push(`  ${file}  [${rule}]`);
}

if (findings.length > 0) {
  console.error("Secret scan failed. Files and rules (values are never printed):");
  for (const finding of findings) console.error(finding);
  console.error("Remove the secret (keep real ones in 1Password and a gitignored .env) and rotate it if it was ever pushed.");
  process.exit(1);
}
console.log("Secret scan: clean");
