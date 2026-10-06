#!/usr/bin/env node
/**
 * owner-merge.yml's job (docs/IMPLEMENTATION.md §23.1, §23.7): the base branch's copy labels a pull request that
 * touches an owner-merge path, or the release PR, turns its auto-merge off and comments once; otherwise it removes the
 * label. Environment: GH_TOKEN, REPOSITORY, PR_NUMBER, PR_HEAD_REF. Dependency-free.
 */
import { readFile } from "node:fs/promises";
import { ghRunner } from "./lib/gh.mjs";
import { ownerMerge } from "./lib/owner-merge.mjs";

const env = process.env;
const repository = env.REPOSITORY ?? "";
const number = Number(env.PR_NUMBER);
if (repository === "" || !Number.isSafeInteger(number) || number < 1) {
  console.error("owner-merge: needs REPOSITORY and PR_NUMBER");
  process.exit(64);
}
const config = JSON.parse(await readFile(new URL("./owner-paths.json", import.meta.url), "utf8"));
const result = await ownerMerge(ghRunner(env), { repository, number, headRef: env.PR_HEAD_REF ?? "", config });
console.log(
  result.ownerMerge
    ? `owner-merge: ${result.reasons.join(", ")}; ${result.actions.join(", ") || "already labeled, auto-merge off"}`
    : `owner-merge: no owner-merge path; ${result.actions.join(", ") || "nothing to do"}`,
);
