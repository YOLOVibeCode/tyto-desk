#!/usr/bin/env node
/**
 * npm run pack — the runtime build (docs/IMPLEMENTATION.md §15.1, §23.6): stamps the checkout (in CI it takes the stamp
 * step's dist/version.json) and packs dist/desk-<version>/ and its tarball with this Node, which must be the pinned one.
 * It writes only dist/, so agents may run it. A refusal names each reason and exits 65.
 * Usage: npm run pack [-- --allow-dirty]
 */
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { NodeCodeSigning } from "../packages/node/src/index.ts";
import { readNodeRuntime } from "./delivery/lib/node-runtime.mjs";
import { packRuntime } from "./lib/pack.mjs";
import { stampedVersion } from "./lib/stamped.mjs";

const { values } = parseArgs({ options: { "allow-dirty": { type: "boolean", default: false } }, strict: true });
const root = resolve(".");
const stamped = await stampedVersion({ root, env: process.env, allowDirty: values["allow-dirty"] });
if (!stamped.ok) {
  console.error("pack: this build is refused; nothing was packed:");
  for (const reason of stamped.reasons) console.error(`  ${reason}`);
  process.exit(65);
}
const packed = await packRuntime({
  root,
  out: join(root, "dist"),
  version: stamped.version,
  platform: process.platform,
  arch: process.arch,
  node: process.execPath,
  runtime: await readNodeRuntime(root),
  signing: new NodeCodeSigning(),
  tarball: true,
});
if (!packed.ok) {
  console.error(`pack: ${packed.reason}`);
  process.exit(65);
}
console.log(`Packed ${stamped.version.version} (${stamped.version.channel}) into ${packed.dir}`);
if (packed.tarball !== null) console.log(`Wrote ${packed.tarball}`);
