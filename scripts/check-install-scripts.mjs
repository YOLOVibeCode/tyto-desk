#!/usr/bin/env node
/**
 * lint:install-scripts — fail when an installed or locked package declares an install script that nobody reviewed, or
 * when an npm project in the checkout (the root, or a project of its own such as the live image's tools) does not set
 * ignore-scripts and save-exact in its own .npmrc, the only one npm reads there.
 * Usage: node scripts/check-install-scripts.mjs [--root <checkout>]
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { allInstallHooks, npmProjectProblems, unreviewedInstallHooks } from "./lib/install-scripts.mjs";

const at = process.argv.indexOf("--root");
const root = resolve(at > 0 ? (process.argv[at + 1] ?? ".") : ".");

const allowed = JSON.parse(await readFile(join(root, "scripts", "allowed-install-scripts.json"), "utf8"));
const unreviewed = unreviewedInstallHooks(await allInstallHooks(root), allowed);
const projects = await npmProjectProblems(root);
if (unreviewed.length > 0) {
  console.error("Installed or locked packages declare install scripts that are not in scripts/allowed-install-scripts.json:");
  for (const hook of unreviewed) console.error(`  ${hook.id} (${hook.hooks.join(", ")})  ${hook.path}`);
  console.error("ignore-scripts keeps them from running. Check that each works without its script, then add");
  console.error('"<name>@<version>": "<why it works without it>" to the allowlist, or drop the dependency.');
}
if (projects.length > 0) {
  console.error("npm projects in the checkout break the supply-chain settings (docs/IMPLEMENTATION.md §2):");
  for (const problem of projects) console.error(`  ${problem}`);
}
if (unreviewed.length > 0 || projects.length > 0) process.exit(1);
console.log("Install scripts: every one reviewed, and every npm project sets ignore-scripts and save-exact in its own .npmrc");
