#!/usr/bin/env node
/**
 * ci.yml's `changes` job (docs/IMPLEMENTATION.md §18): on a pull request, its file list (REST API) classified by this,
 * the base commit's copy; on main, everything is code. Appends `code=true|false` to GITHUB_OUTPUT.
 * Environment: GITHUB_EVENT_NAME, GITHUB_OUTPUT; for a pull request also REPOSITORY, PR_NUMBER, PR_CHANGED_FILES and
 * GH_TOKEN.
 */
import { appendFile } from "node:fs/promises";
import { ghRunner } from "./lib/gh.mjs";
import { pullRequestChanges } from "./lib/ci-changes.mjs";

/** @param {string | undefined} text */
function count(text) {
  return text !== undefined && /^\d+$/.test(text) ? Number(text) : null;
}

const env = process.env;
let code = true;
if (env.GITHUB_EVENT_NAME === "pull_request") {
  const number = count(env.PR_NUMBER);
  const repository = env.REPOSITORY ?? "";
  if (number === null || repository === "") {
    console.error("ci-changes: a pull request needs REPOSITORY and PR_NUMBER");
    process.exit(64);
  }
  ({ code } = await pullRequestChanges(ghRunner(env), {
    repository,
    number,
    changedFiles: count(env.PR_CHANGED_FILES),
  }));
}
if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `code=${code}\n`);
console.log(code ? "Changes: code (check and macos run)" : "Changes: docs only (check and macos are skipped)");
