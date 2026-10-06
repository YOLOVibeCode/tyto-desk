// @ts-check
/**
 * Phase 1 of the live harness, inside the container (docs/IMPLEMENTATION.md §17.3). scripts/live.mjs starts it once per
 * package-lock.json, with the network on, the repo read-only at /src, and the dependency volume at /work/node_modules.
 * It copies the package files into /work and runs `npm ci --ignore-scripts` there, so linux-arm64 modules land in the
 * volume and never in the Mac's node_modules. The volume is ready once `.desk-live-ready` exists.
 * stdin is the runner's lifeline: when it closes before npm finishes, the install stops.
 */
import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SRC, WORK, sha256Hex, suiteRefusal } from "../../../scripts/lib/live.mjs";

const MINUTE = 60_000;
const READY = join(WORK, "node_modules", ".desk-live-ready");

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`phase 1: ${message}`);
  process.exit(1);
}

const refusal = suiteRefusal({ platform: process.platform, env: process.env });
if (refusal !== null) fail(refusal);

/** @param {string} path */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (err) {
    if (/** @type {{ code?: string }} */ (err).code === "ENOENT") return false;
    throw err;
  }
}

const manifest = JSON.parse(await readFile(join(SRC, "package.json"), "utf8"));
/** @type {unknown[]} */
const declared = Array.isArray(manifest.workspaces) ? manifest.workspaces : [];
/** @type {string[]} */
const workspaces = [];
for (const workspace of declared) {
  if (typeof workspace !== "string" || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(workspace)) {
    fail(`workspace ${JSON.stringify(workspace)} is not a plain relative path (globs are not supported here)`);
  }
  workspaces.push(workspace);
}

for (const file of ["package.json", "package-lock.json", ".npmrc", ...workspaces.map((w) => `${w}/package.json`)]) {
  const from = join(SRC, file);
  if (file === ".npmrc" && !(await exists(from))) continue;
  await mkdir(dirname(join(WORK, file)), { recursive: true });
  await copyFile(from, join(WORK, file));
}

const npm = spawn("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: WORK,
  stdio: ["ignore", "inherit", "inherit"],
  signal: AbortSignal.timeout(15 * MINUTE),
  env: {
    HOME: process.env.HOME ?? "/home/lab",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    TMPDIR: "/tmp",
    npm_config_cache: "/cache/npm",
    npm_config_update_notifier: "false",
  },
});
process.stdin.on("end", () => npm.kill("SIGTERM"));
process.stdin.resume();
const code = await new Promise((resolve) => {
  npm.once("error", () => resolve(1));
  npm.once("close", (status) => resolve(status ?? 1));
});
if (code !== 0) fail(`npm ci --ignore-scripts exited with ${code}`);

for (const workspace of workspaces) {
  if (await exists(join(WORK, workspace, "node_modules"))) {
    fail(`npm put ${workspace}/node_modules outside the dependency volume; the live harness supports hoisted trees only`);
  }
}

await writeFile(READY, `${sha256Hex(await readFile(join(WORK, "package-lock.json")))}\n`);
console.log("phase 1: dependencies installed");
process.exit(0);
