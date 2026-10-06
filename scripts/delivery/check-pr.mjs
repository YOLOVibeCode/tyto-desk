#!/usr/bin/env node
/**
 * The PR check (docs/IMPLEMENTATION.md §23.1, §23.7), the `pr-title` required check.
 *
 *   node scripts/delivery/check-pr.mjs --title "<title>" [--branch <branch>]
 *     before `gh pr create`: checks the title and the branch (default: the checked-out branch).
 *   node scripts/delivery/check-pr.mjs --github
 *     in `pr-title.yml`, from main's checkout: the title and head branch come from PR_TITLE, PR_HEAD_REF and
 *     PR_HEAD_REPO (through env), and the pull request's workflow files are read through the REST API at PR_HEAD_SHA
 *     and checked against these workflow rules, each pinned SHA against its tag. Nothing from the PR is run.
 *
 * Exits 1 naming each problem.
 */
import { parseArgs } from "node:util";
import { currentBranch, gitEnvFrom, gitRunner } from "./lib/git-facts.mjs";
import { ghRunner } from "./lib/gh.mjs";
import { checkTitleAndBranch, checkWorkflowFiles, ghPullRequestSource } from "./lib/pr-check.mjs";

/** @param {string} message @returns {never} */
function usage(message) {
  console.error(`check-pr: ${message}`);
  process.exit(64);
}

let values;
try {
  values = parseArgs({
    options: { title: { type: "string" }, branch: { type: "string" }, github: { type: "boolean", default: false } },
    strict: true,
  }).values;
} catch (err) {
  usage(err instanceof Error ? err.message : String(err));
}

/** @type {string[]} */
let problems;
if (values.github) {
  const env = process.env;
  const title = env.PR_TITLE ?? "";
  const branch = env.PR_HEAD_REF ?? "";
  const repository = env.REPOSITORY ?? "";
  const headSha = env.PR_HEAD_SHA ?? "";
  if (repository === "" || !/^[0-9a-f]{40}$/.test(headSha)) usage("--github needs REPOSITORY and PR_HEAD_SHA");
  const fork = env.PR_HEAD_REPO !== repository;
  problems = checkTitleAndBranch({ title, branch, fork });
  problems.push(...(await checkWorkflowFiles(ghPullRequestSource(ghRunner(env), { repository, headSha }))));
} else {
  if (values.title === undefined) usage('--title "<title>" is required (or --github in the workflow)');
  const branch =
    values.branch ?? (await currentBranch(gitRunner({ cwd: process.cwd(), env: gitEnvFrom(process.env) })));
  if (branch === null) usage("HEAD is detached; pass --branch");
  problems = checkTitleAndBranch({ title: values.title, branch, fork: false });
}

if (problems.length > 0) {
  console.error("The PR check failed (CONTRIBUTING: pull request titles, branches, workflow rules):");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log("PR check: the title, the branch and the workflow files pass");
