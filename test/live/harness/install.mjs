// @ts-check
/**
 * Phase 1 of the live harness, inside the container (docs/IMPLEMENTATION.md §17.3). The runner starts it with the
 * network on and only the package files mounted read-only under /src (package.json, package-lock.json, .npmrc, the
 * workspaces' package.json, and this script with scripts/lib/live.mjs), the dependency volume at /work/node_modules,
 * and the cache at /cache, under `flock` on a lock file in the cache, so two runs never install into one volume at once.
 * It copies the package files into /work and runs `npm ci --ignore-scripts` there, so linux-arm64 modules land in the
 * volume and never in the Mac's node_modules. The volume is ready once `.desk-live-ready` exists; a run that waited for
 * the lock finds it and installs nothing. stdin is the runner's lifeline: when it closes before npm finishes, the
 * install stops.
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SRC, WORK, installInputs, sha256Hex, suiteRefusal } from "../../../scripts/lib/live.mjs";

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
async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (err) {
    if (/** @type {{ code?: string }} */ (err).code === "ENOENT") return false;
    throw err;
  }
}

if (!(await isFile(join(SRC, "package.json")))) {
  fail("the repo's package.json is not visible at /src: on the Mac, Colima shares only your home directory");
}
if (await isFile(READY)) {
  console.log("phase 1: another run installed these dependencies while this one waited");
  process.exit(0);
}

const inputs = installInputs(await readFile(join(SRC, "package.json"), "utf8"), await isFile(join(SRC, ".npmrc")));
if (!inputs.ok) fail(inputs.reason);
for (const file of inputs.files) {
  await mkdir(dirname(join(WORK, file)), { recursive: true });
  await copyFile(join(SRC, file), join(WORK, file));
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

for (const workspace of inputs.workspaces) {
  if (await stat(join(WORK, workspace, "node_modules")).then(() => true, () => false)) {
    fail(`npm put ${workspace}/node_modules outside the dependency volume; the live harness supports hoisted trees only`);
  }
}

await writeFile(READY, `${sha256Hex(await readFile(join(WORK, "package-lock.json")))}\n`);
console.log("phase 1: dependencies installed");
process.exit(0);
