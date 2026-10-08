#!/usr/bin/env node
/**
 * The stamp (docs/IMPLEMENTATION.md §23.3): decides what this build is with core's `classifyBuild` and writes
 * `version.json` into the build output (dist/ by default), never into the repository. In CI it also appends version,
 * channel, publish, live and label to GITHUB_OUTPUT. A refusal names each reason and exits 65; nothing is written.
 *
 * Usage: node scripts/delivery/stamp.mjs [--out <dir>] [--allow-dirty] [--dry-run] [--expect-channel <channel>]
 *        [--plan]
 *   --plan            classify only: write no version.json (release.yml's plan job)
 *   --dry-run         release.yml dispatched on main: a stable-shaped build that publishes nothing
 *   --expect-channel  fail unless the build is this channel (the workflow's input)
 */
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { classifyBuild } from "../../packages/core/src/release/classify-build.ts";
import { gitEnvFrom, gitRunner } from "./lib/git-facts.mjs";
import {
  REFUSAL_TEXT,
  gatherBuildFacts,
  githubOutput,
  outsideTheRepository,
  pinnedNode,
  versionFile,
  writeVersionFile,
} from "./lib/stamp.mjs";

/** @param {string} message @param {number} code @returns {never} */
function fail(message, code) {
  console.error(message);
  process.exit(code);
}

let options;
try {
  options = parseArgs({
    options: {
      out: { type: "string", default: "dist" },
      "allow-dirty": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "expect-channel": { type: "string" },
      plan: { type: "boolean", default: false },
    },
    strict: true,
  }).values;
} catch (err) {
  fail(`stamp: ${err instanceof Error ? err.message : String(err)}`, 64);
}

const root = resolve(".");
const git = gitRunner({ cwd: root, env: gitEnvFrom(process.env) });

const facts = await gatherBuildFacts({
  root,
  env: process.env,
  git,
  now: () => new Date(),
  allowDirty: options["allow-dirty"],
  dryRun: options["dry-run"],
});
if (facts.problems.length > 0) fail(`stamp: ${facts.problems.join("; ")}`, 65);

// The pin is read before the build is classified: a refused build names it with its other refusals.
/** @type {{ ok: true; node: string } | { ok: false; reason: string }} */
const pin = await pinnedNode(root).then(
  (node) => ({ ok: true, node }),
  (err) => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }),
);

const build = classifyBuild(facts.input);
if (!build.ok) {
  console.error("stamp: this build is refused; nothing was written:");
  for (const refusal of build.refusals) console.error(`  ${refusal}: ${REFUSAL_TEXT[refusal]}`);
  if (!pin.ok) console.error(`  node-pin: ${pin.reason}`);
  if (build.refusals.includes("dirty-tree")) {
    console.error(facts.dirtyFiles === null ? "  git could not list the changes" : "Uncommitted or untracked files:");
    for (const file of facts.dirtyFiles ?? []) console.error(`  ${file}`);
  }
  process.exit(65);
}

/** @param {string} word */
const article = (word) => (/^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`);
const expected = options["expect-channel"];
if (expected !== undefined && expected !== build.channel) {
  console.error(`stamp: expected ${article(expected)} build, but this is ${article(build.channel)} build (${build.version})`);
  if (!pin.ok) console.error(`  node-pin: ${pin.reason}`);
  process.exit(65);
}

// A bad --out (64) is named before a refused pin, which alone would otherwise hide it.
const outDir = resolve(root, options.out);
if (!options.plan && !(await outsideTheRepository(git, root, outDir))) {
  fail(`stamp: version.json goes into the build output (dist/), never into the repository: ${options.out}`, 64);
}
if (!pin.ok) fail(`stamp: the Node pin is refused (${pin.reason}); nothing was written`, 65);

if (!options.plan) await writeVersionFile(outDir, versionFile(facts.input, build, pin.node));
if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, githubOutput(build));
}
console.log(
  options.plan
    ? `Planned ${build.version} (${build.channel}; publish ${build.publish}; live ${build.live})`
    : `Stamped ${build.version} (${build.channel}) into ${options.out}/version.json`,
);
