#!/usr/bin/env node
/**
 * test:live — the only part of the live suite that runs on the Mac, where it drives `docker --context colima` and
 * nothing else, or, with `--ci`, on a GitHub Actions linux-arm64 runner, where it drives the runner's own Docker engine
 * (docs/IMPLEMENTATION.md §17.3). Chrome, the PTYs and agent-browser run in a Linux container under Xvfb; nothing opens
 * on the screen. scripts/lib/live-runner.mjs does the work with this process's environment, platform and output.
 *
 * Usage: npm run test:live [-- <vitest filters or flags>]     on the Mac, with Colima running
 *        npm run test:live -- --ci                             in GitHub Actions (live-run.yml)
 */
import { homedir, hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runLive } from "./lib/live-runner.mjs";

const code = await runLive({
  argv: process.argv.slice(2),
  env: process.env,
  platform: process.platform,
  arch: process.arch,
  repo: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  home: homedir(),
  host: hostname(),
  pid: process.pid,
  docker: "docker",
  procSys: "/proc/sys",
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  signals: process,
  now: Date.now,
});
process.exit(code);
