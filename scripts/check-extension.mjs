#!/usr/bin/env node
/**
 * lint:extension — stub until packages/extension exists (slices 1c and 6). The real lint bans
 * chrome.debugger.attach, sendCommand and detach, innerHTML, outerHTML, insertAdjacentHTML, document.write, eval,
 * Function( and any node: import in the extension (docs/IMPLEMENTATION.md §9), and lands test-first with that package.
 * Until then it passes only while there is nothing to lint, so the package cannot arrive unlinted.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const at = process.argv.indexOf("--root");
const root = resolve(at > 0 ? (process.argv[at + 1] ?? ".") : ".");

if (existsSync(join(root, "packages", "extension"))) {
  console.error("lint:extension: packages/extension exists but its lint is still the slice 1a stub.");
  console.error("Write the extension lint and its tests first (docs/IMPLEMENTATION.md §9, slice 6).");
  process.exit(1);
}
console.log("Extension lint: no packages/extension yet");
