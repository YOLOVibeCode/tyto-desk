#!/usr/bin/env node
/**
 * dependabot-auto-merge.yml's decision (docs/IMPLEMENTATION.md §23.7, D44, D54): reads UPDATED_DEPENDENCIES_JSON
 * (fetch-metadata's output, through env) and, for an update of the allowed class, main's active rules through gh
 * (REPOSITORY, GH_TOKEN; read-only), then appends `merge=true|false` and a one-line `reason` to GITHUB_OUTPUT.
 * Dependency-free.
 */
import { appendFile } from "node:fs/promises";
import { ghRunner } from "./lib/gh.mjs";
import { automergeDecision, decideAutomerge } from "./lib/automerge-decision.mjs";

/** @type {unknown} */
let updates = null;
try {
  updates = JSON.parse(process.env.UPDATED_DEPENDENCIES_JSON ?? "null");
} catch {
  updates = null;
}
const repository = process.env.REPOSITORY ?? "";
const { merge, reason } =
  repository === ""
    ? automergeDecision(updates, { checksRequired: false })
    : await decideAutomerge(ghRunner(process.env), { repository, updates });
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `merge=${merge}\nreason=${reason}\n`);
console.log(merge ? `Auto-merge: on (${reason})` : `Auto-merge: the owner decides (${reason})`);
