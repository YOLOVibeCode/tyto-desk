#!/usr/bin/env node
/**
 * lint:extension — the extension's own source never attaches the debugger, writes markup from strings, builds code
 * from strings, or imports Node (docs/IMPLEMENTATION.md §9). Prints file, line and rule, never more of the source.
 * Usage: node scripts/check-extension.mjs [--root <repo>]
 */
import { join, resolve } from "node:path";
import { extensionViolations } from "./lib/extension-lint.mjs";

const at = process.argv.indexOf("--root");
const root = resolve(at > 0 ? (process.argv[at + 1] ?? ".") : ".");

const violations = await extensionViolations(join(root, "packages", "extension"));
if (violations.length > 0) {
  console.error("The Desk extension must not attach the debugger, write markup from strings, run strings as code, or import Node:");
  for (const v of violations) console.error(`  packages/extension/${v.file}:${v.line}  [${v.rule}]`);
  process.exit(1);
}
console.log("Extension lint: clean");
