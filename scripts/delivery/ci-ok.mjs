#!/usr/bin/env node
/**
 * ci.yml's `ci-ok` job (docs/IMPLEMENTATION.md §23.7), the one required build check. Environment: NEEDS (the
 * workflow's toJSON(needs)), EVENT_NAME, HEAD_REF. Exits 1 naming why.
 */
import { ciOk } from "./lib/ci-ok.mjs";

/** @type {Record<string, import("./lib/ci-ok.mjs").Need | undefined>} */
let needs = {};
try {
  needs = JSON.parse(process.env.NEEDS ?? "{}");
} catch {
  console.error("ci-ok: NEEDS is not JSON");
  process.exit(1);
}
const verdict = ciOk({ needs, event: process.env.EVENT_NAME ?? "", headRef: process.env.HEAD_REF ?? "" });
if (!verdict.ok) {
  console.error("ci-ok failed:");
  for (const reason of verdict.reasons) console.error(`  ${reason}`);
  process.exit(1);
}
console.log("ci-ok: every needed job passed");
