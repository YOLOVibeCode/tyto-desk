#!/usr/bin/env node
/**
 * release.yml's `publish` steps (docs/IMPLEMENTATION.md §23.8), in the `publish` environment after the owner approves.
 *
 *   node scripts/delivery/publish.mjs prepare   check the artifact, find the release; appends next=attest|verify
 *   node scripts/delivery/publish.mjs finish    upload to the draft, check the assets, publish (latest only if highest)
 *
 * Environment: GH_TOKEN, REPOSITORY, TAG, ASSETS_DIR (the downloaded artifact), GITHUB_OUTPUT. Exits 1 naming each
 * problem; nothing is published unless every check passed.
 */
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ghRunner } from "./lib/gh.mjs";
import { finish, prepare } from "./lib/publish.mjs";

const step = process.argv[2];
const env = process.env;
const repository = env.REPOSITORY ?? "";
const tag = env.TAG ?? "";
const dir = resolve(env.ASSETS_DIR ?? "release");
if ((step !== "prepare" && step !== "finish") || repository === "" || tag === "") {
  console.error("Usage: publish.mjs prepare|finish, with REPOSITORY, TAG and ASSETS_DIR set");
  process.exit(64);
}

const gh = ghRunner(env);
const result = step === "prepare" ? await prepare(gh, { repository, tag, dir }) : await finish(gh, { repository, tag, dir });
if (!result.ok) {
  console.error(`publish ${step}: refused; nothing was published:`);
  for (const problem of result.problems) console.error(`  ${problem}`);
  process.exit(1);
}
if ("next" in result) {
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `next=${result.next}\n`);
  console.log(result.next === "verify" ? `${tag} is already published with matching assets: verify` : `${tag} is a draft: attest, then finish`);
} else {
  console.log(`Published ${tag}${result.latest ? " as latest" : " (not latest: a higher version is published)"}`);
}
