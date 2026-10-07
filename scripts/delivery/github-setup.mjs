#!/usr/bin/env node
/**
 * Every repository setting of YOLOVibeCode/tyto-desk (docs/IMPLEMENTATION.md §23.2; RELEASING.md, one-time setup).
 *
 *   node scripts/delivery/github-setup.mjs            --check, the default: prints desired and actual, changes nothing,
 *                                                     exits 1 naming each setting that differs
 *   node scripts/delivery/github-setup.mjs --apply    asks on an interactive terminal (there is no --yes), changes only
 *                                                     what differs, reads it back; a second run changes nothing
 *
 * The operator runs --apply; agents never do (CONTRIBUTING, rule 7). Secrets are listed by name only and are set by
 * hand. The signed-in account is named with `gh api user`.
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { ghRunner } from "./lib/gh.mjs";
import { runSetup } from "./lib/github-setup.mjs";

/** The repository these settings belong to. */
const REPOSITORY = "YOLOVibeCode/tyto-desk";

/**
 * The Desk Release App's slug, `null` until the App exists (RELEASING.md, one-time setup 2). Setting it gives the
 * `tags` and `release branch` rulesets the App as their only bypass actor, and makes --check require its client id and
 * key in the release-please environment.
 * @type {string | null}
 */
const RELEASE_APP_SLUG = null;

let values;
try {
  values = parseArgs({ options: { check: { type: "boolean" }, apply: { type: "boolean" } }, strict: true }).values;
} catch (err) {
  console.error(`github-setup: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(64);
}
if (values.check && values.apply) {
  console.error("github-setup: --check or --apply, not both");
  process.exit(64);
}

/** @param {string} question */
async function confirm(question) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`${question}\nType yes to apply: `);
    return answer.trim().toLowerCase() === "yes";
  } finally {
    terminal.close();
  }
}

const code = await runSetup({
  mode: values.apply ? "apply" : "check",
  gh: ghRunner(process.env),
  repository: REPOSITORY,
  appSlug: RELEASE_APP_SLUG,
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  confirm,
  print: (line) => console.log(line),
});
process.exit(code);
