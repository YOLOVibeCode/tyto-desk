#!/usr/bin/env node
/**
 * dependabot-auto-merge.yml's decision (docs/IMPLEMENTATION.md §23.7): reads UPDATED_DEPENDENCIES_JSON (fetch-metadata's
 * output, through env) and appends `merge=true|false` and a one-line `reason` to GITHUB_OUTPUT. Dependency-free.
 */
import { appendFile } from "node:fs/promises";
import { automergeDecision } from "./lib/automerge-decision.mjs";

/** @type {unknown} */
let updates = null;
try {
  updates = JSON.parse(process.env.UPDATED_DEPENDENCIES_JSON ?? "null");
} catch {
  updates = null;
}
const { merge, reason } = automergeDecision(updates);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `merge=${merge}\nreason=${reason}\n`);
console.log(merge ? `Auto-merge: on (${reason})` : `Auto-merge: the owner decides (${reason})`);
