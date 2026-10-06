#!/usr/bin/env node
/**
 * lint:install-scripts — fail when an installed or locked package declares an install script that nobody reviewed.
 * Usage: node scripts/check-install-scripts.mjs [--root <checkout>]
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { allInstallHooks, unreviewedInstallHooks } from "./lib/install-scripts.mjs";

const at = process.argv.indexOf("--root");
const root = resolve(at > 0 ? (process.argv[at + 1] ?? ".") : ".");

const allowed = JSON.parse(await readFile(join(root, "scripts", "allowed-install-scripts.json"), "utf8"));
const unreviewed = unreviewedInstallHooks(await allInstallHooks(root), allowed);
if (unreviewed.length > 0) {
  console.error("Installed or locked packages declare install scripts that are not in scripts/allowed-install-scripts.json:");
  for (const hook of unreviewed) console.error(`  ${hook.id} (${hook.hooks.join(", ")})  ${hook.path}`);
  console.error("ignore-scripts keeps them from running. Check that each works without its script, then add");
  console.error('"<name>@<version>": "<why it works without it>" to the allowlist, or drop the dependency.');
  process.exit(1);
}
console.log("Install scripts: every one reviewed");
