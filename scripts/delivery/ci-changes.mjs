#!/usr/bin/env node
/**
 * ci.yml's `changes` job (docs/IMPLEMENTATION.md §18, D82): on a pull request, its file list (REST API) classified by
 * this, the base commit's copy, with the base commit's owner-paths.json, while its head is still the event's; on main,
 * everything is code. Appends `code=true|false` to GITHUB_OUTPUT. Environment: GITHUB_EVENT_NAME, GITHUB_OUTPUT; for a
 * pull request also REPOSITORY, PR_NUMBER, PR_HEAD_SHA and GH_TOKEN.
 */
import { appendFile } from "node:fs/promises";
import { ghRunner } from "./lib/gh.mjs";
import { pullRequestChanges } from "./lib/ci-changes.mjs";
import { readOwnerPaths } from "./lib/owner-paths.mjs";

const env = process.env;
let code = true;
if (env.GITHUB_EVENT_NAME === "pull_request") {
  const number = /^\d+$/.test(env.PR_NUMBER ?? "") ? Number(env.PR_NUMBER) : null;
  const repository = env.REPOSITORY ?? "";
  if (number === null || repository === "") {
    console.error("ci-changes: a pull request needs REPOSITORY and PR_NUMBER");
    process.exit(64);
  }
  const headSha = /^[0-9a-f]{40}$/.test(env.PR_HEAD_SHA ?? "") ? (env.PR_HEAD_SHA ?? null) : null;
  const { paths: ownerPaths } = await readOwnerPaths();
  ({ code } = await pullRequestChanges(ghRunner(env), { repository, number, headSha, ownerPaths }));
}
if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `code=${code}\n`);
console.log(code ? "Changes: code (check and macos run)" : "Changes: docs only (check and macos are skipped)");
