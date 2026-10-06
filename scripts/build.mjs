#!/usr/bin/env node
/**
 * build — the bundles build, and no production module spells a forbidden Chrome switch (docs/IMPLEMENTATION.md §5).
 * The forbidden lists are read from the bundled core itself, so there is one of each. Usage: node scripts/build.mjs
 */
import { resolve } from "node:path";
import { buildBundles, spelledForbiddenSwitches } from "./lib/build.mjs";

const root = resolve(".");
const bundles = await buildBundles(root);
const core = bundles.find((bundle) => bundle.path === "core/index.js");
if (!core) throw new Error("the core bundle is missing");
const { FORBIDDEN_CHROME_SWITCHES, FORBIDDEN_CHROME_SWITCH_VALUES } = await import(
  `data:text/javascript;base64,${Buffer.from(core.text).toString("base64")}`
);

const spelled = spelledForbiddenSwitches(bundles, FORBIDDEN_CHROME_SWITCHES, FORBIDDEN_CHROME_SWITCH_VALUES);
if (spelled.length > 0) {
  console.error("A bundle spells a Chrome switch Desk never passes:");
  for (const { path, flag } of spelled) console.error(`  ${path}  ${flag}`);
  process.exit(1);
}
for (const bundle of bundles) console.log(`Built ${bundle.path} (${(bundle.text.length / 1024).toFixed(1)} KiB)`);
