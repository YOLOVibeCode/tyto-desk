#!/usr/bin/env node
/**
 * lint:workflows — every workflow in .github/workflows keeps the rules of docs/IMPLEMENTATION.md §23.7
 * (scripts/delivery/lib/workflow-rules.mjs). Offline: `main`'s pr-title also checks each pinned SHA against its tag.
 * Prints file, line and rule, never more of the file. Usage: node scripts/delivery/lint-workflows.mjs [--root <repo>]
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkWorkflows } from "./lib/workflow-rules.mjs";

const at = process.argv.indexOf("--root");
const root = resolve(at > 0 ? (process.argv[at + 1] ?? ".") : ".");
const dir = join(root, ".github", "workflows");

/** @type {string[]} */
let names = [];
try {
  names = (await readdir(dir)).filter((name) => /\.ya?ml$/.test(name)).sort();
} catch (err) {
  if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
}
const files = await Promise.all(
  names.map(async (name) => ({ path: `.github/workflows/${name}`, text: await readFile(join(dir, name), "utf8") })),
);
const violations = checkWorkflows(files);
if (violations.length > 0) {
  console.error("Workflows break the rules of docs/IMPLEMENTATION.md §23.7:");
  for (const v of violations) console.error(`  ${v.file}:${v.line ?? "?"}  [${v.rule}] ${v.detail}`);
  process.exit(1);
}
console.log(`Workflows: ${files.length} files, every rule kept`);
