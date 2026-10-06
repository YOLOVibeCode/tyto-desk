#!/usr/bin/env node
/**
 * lint:listen — every listen() in packages/ names 127.0.0.1 or a socket path (docs/IMPLEMENTATION.md §12).
 * Usage: node scripts/check-listen.mjs [--root <repo>]
 */
import { join, relative, resolve } from "node:path";
import { listenViolations, packageSourceFiles } from "./lib/listen.mjs";

const at = process.argv.indexOf("--root");
const root = resolve(at > 0 ? (process.argv[at + 1] ?? ".") : ".");

const files = await packageSourceFiles(root);
const violations = listenViolations(files, { typeRoots: [join(root, "node_modules", "@types")] });
if (violations.length > 0) {
  console.error("Desk listens on 127.0.0.1 or a Unix socket only (Node binds every interface without a host):");
  for (const v of violations) console.error(`  ${relative(root, v.file)}:${v.line}  ${v.detail}`);
  process.exit(1);
}
console.log(`Listeners: ${files.length} files, every listen() on 127.0.0.1 or a socket path`);
