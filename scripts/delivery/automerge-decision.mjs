#!/usr/bin/env node
/**
 * dependabot-auto-merge.yml's decision (docs/IMPLEMENTATION.md §23.7, D44, D54, D83): reads UPDATED_DEPENDENCIES_JSON
 * (fetch-metadata's output, through env) and, for an update of the allowed class, the pull request (its commits, files
 * and head) and main's active rules through gh (REPOSITORY, PR_NUMBER, PR_HEAD_SHA, GH_TOKEN; read-only), with this
 * copy's owner-paths.json, then appends `merge=true|false` and a one-line `reason` to GITHUB_OUTPUT. Dependency-free.
 */
import { appendFile } from "node:fs/promises";
import { ghRunner } from "./lib/gh.mjs";
import { decideAutomerge } from "./lib/automerge-decision.mjs";
import { readOwnerPaths } from "./lib/owner-paths.mjs";

const env = process.env;
/** @type {unknown} */
let updates = null;
try {
  updates = JSON.parse(env.UPDATED_DEPENDENCIES_JSON ?? "null");
} catch {
  updates = null;
}
const { paths: ownerPaths } = await readOwnerPaths();
const decision = await decideAutomerge(ghRunner(env), {
  repository: env.REPOSITORY ?? "",
  number: /^\d+$/.test(env.PR_NUMBER ?? "") ? Number(env.PR_NUMBER) : Number.NaN,
  headSha: env.PR_HEAD_SHA ?? "",
  updates,
  ownerPaths,
});
const merge = decision.merge;
// One line, whatever a reason quotes: GITHUB_OUTPUT reads a line break as a new output.
const reason = decision.reason.replace(/[\r\n]+/g, " ");
if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `merge=${merge}\nreason=${reason}\n`);
console.log(merge ? `Auto-merge: on (${reason})` : `Auto-merge: the owner decides (${reason})`);
