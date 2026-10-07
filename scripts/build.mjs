#!/usr/bin/env node
/**
 * build — the bundles build (core for a neutral platform, the extension, the runtime's desk.mjs), and (§5, §9, §15.1,
 * §18): no production module spells a forbidden Chrome switch; the extension's manifest key gives the id the native
 * host's manifest allows, with §9's CSP and no external connections; every package a bundle takes is a dependency of
 * the workspace that imports it, never a devDependency; and no production bundle carries the live suite's test hooks.
 * Usage: node scripts/build.mjs
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DESK_EXTENSION_ID, FORBIDDEN_CHROME_SWITCHES, FORBIDDEN_CHROME_SWITCH_VALUES } from "../packages/core/src/index.ts";
import { buildBundles, extensionManifestProblems, spelledForbiddenSwitches, undeclaredBundledPackages } from "./lib/build.mjs";

const root = resolve(".");
const { bundles, metafiles } = await buildBundles(root);
/** @type {string[]} */
const problems = [];

for (const { path, flag } of spelledForbiddenSwitches(bundles, FORBIDDEN_CHROME_SWITCHES, FORBIDDEN_CHROME_SWITCH_VALUES)) {
  problems.push(`${path} spells ${flag}, a Chrome switch Desk never passes`);
}
const manifest = JSON.parse(await readFile(resolve(root, "packages", "extension", "manifest.json"), "utf8"));
for (const problem of extensionManifestProblems(manifest, DESK_EXTENSION_ID)) problems.push(`packages/extension/manifest.json: ${problem}`);
for (const { bundle, importer, bundled, declaredIn } of await undeclaredBundledPackages(root, metafiles)) {
  problems.push(`the ${bundle} bundle takes ${bundled} from ${importer}, which lists it in ${declaredIn}, not dependencies`);
}
for (const bundle of bundles) {
  if (bundle.text.includes("deskTest")) problems.push(`${bundle.path} carries the live suite's test hooks`);
}

if (problems.length > 0) {
  console.error("The build is refused:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
for (const bundle of bundles) console.log(`Built ${bundle.path} (${(bundle.text.length / 1024).toFixed(1)} KiB)`);
console.log(`The extension's key gives ${DESK_EXTENSION_ID}, the id the native host's manifest allows`);
