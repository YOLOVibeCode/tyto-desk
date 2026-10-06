#!/usr/bin/env node
/**
 * lint:imports — keep @desk/core pure and browser-safe (docs/IMPLEMENTATION.md §0). Prints file, line and the rule
 * broken, never more of the source. Usage: node scripts/check-core-imports.mjs [--root <repo>]
 */
import { join, resolve } from "node:path";
import { coreBoundaryViolations } from "./lib/core-boundary.mjs";

const at = process.argv.indexOf("--root");
const root = resolve(at > 0 ? (process.argv[at + 1] ?? ".") : ".");

const violations = await coreBoundaryViolations(join(root, "packages/core"));
if (violations.length > 0) {
  console.error("@desk/core must stay pure: no Node builtins or globals, no I/O or browser packages, no chrome.* APIs.");
  for (const v of violations) console.error(`  ${v.file}:${v.line}  [${v.rule}] ${v.detail}`);
  process.exit(1);
}
console.log("Core import boundary: clean");
