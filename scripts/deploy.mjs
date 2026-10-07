#!/usr/bin/env node
/**
 * npm run deploy — the operator's alone (docs/IMPLEMENTATION.md §23.5; CONTRIBUTING rule 7): builds this checkout as a
 * dev version and installs it into ~/.desk after asking. Agents never run it. Usage: npm run deploy [-- --allow-dirty]
 */
import { resolve } from "node:path";
import { deploy } from "./lib/deploy.mjs";

process.exitCode = await deploy({
  argv: process.argv.slice(2),
  env: process.env,
  platform: process.platform,
  arch: process.arch,
  isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
  nodeVersion: process.versions.node,
  root: resolve("."),
  say: (text) => console.log(text),
  warn: (text) => console.error(text),
});
