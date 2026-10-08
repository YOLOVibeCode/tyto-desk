/**
 * npm run deploy (docs/IMPLEMENTATION.md §23.5, slice 1c): the operator's way to install this checkout on their Mac as a
 * dev version. It refuses CI, Vitest, anything but macOS on arm64, a Node that is not the pinned one, a missing
 * interactive terminal, and a dirty tree without --allow-dirty; then it stamps (classifyBuild, `local`), packs, and runs
 * the packed runtime's own `desk install --from dist/desk-<version>`, which asks, installs and switches current. It
 * never starts Chrome and never runs the installed desk. Agents never run it: it changes the operator's ~/.desk (§0).
 * Every input comes from the caller ({argv, env, platform, arch, …}), so tests inject each one.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { terminalBinary } from "../../packages/core/src/index.ts";
import { readNodeRuntime } from "../delivery/lib/node-runtime.mjs";
import { packRuntime } from "./pack.mjs";
import { stampedVersion } from "./stamped.mjs";
import { NodeCodeSigning } from "../../packages/node/src/index.ts";

/** @typedef {import("../../packages/core/src/index.ts").VersionInfo} VersionInfo */
/** @typedef {import("./pack.mjs").PackResult} PackResult */
/** @typedef {import("./stamped.mjs").Stamped} Stamped */
/** @typedef {import("../delivery/lib/node-runtime.mjs").NodeRuntime} NodeRuntime */

/**
 * The packed runtime's own install, with this terminal as its terminal, so it asks the operator itself.
 * @param {string} dir
 * @param {string} platform
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<number>}
 */
function installWithPackedRuntime(dir, platform, env) {
  /** @type {Record<string, string>} */
  const childEnv = {};
  for (const name of ["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG", "TERM", "DESK_HOME"]) {
    const value = env[name];
    if (value !== undefined) childEnv[name] = value;
  }
  // The operator's own install, on their Mac at a terminal (deploy refuses CI and Vitest): it may offer Desk.app and the
  // login agent, as the desk launcher's installs do (§15.1).
  childEnv.DESK_ALLOW_GUI = "1";
  return new Promise((resolve) => {
    const child = spawn(join(dir, terminalBinary(platform)), [join(dir, "desk.mjs"), "install", "--from", dir], { stdio: "inherit", env: childEnv });
    child.once("error", () => resolve(70));
    child.once("close", (code) => resolve(code ?? 70));
  });
}

/**
 * @param {{
 *   argv: readonly string[];
 *   env: Record<string, string | undefined>;
 *   platform: string;
 *   arch: string;
 *   isTTY: boolean;
 *   nodeVersion: string;
 *   root: string;
 *   runtime?: NodeRuntime;
 *   stamp?: (allowDirty: boolean) => Promise<Stamped>;
 *   pack?: (version: VersionInfo) => Promise<PackResult>;
 *   install?: (dir: string) => Promise<number>;
 *   say: (text: string) => void;
 *   warn: (text: string) => void;
 * }} input
 * @returns {Promise<number>} the exit code
 */
export async function deploy(input) {
  const { argv, env, platform, arch, root, say, warn } = input;
  const refuse = (/** @type {number} */ code, /** @type {string} */ text) => {
    warn(text);
    return code;
  };
  if (argv.some((arg) => arg !== "--allow-dirty")) return refuse(64, "usage: npm run deploy [-- --allow-dirty]");
  if (env.CI !== undefined || env.VITEST !== undefined) {
    return refuse(64, "npm run deploy installs on the operator's Mac only: never in CI or under Vitest");
  }
  if (platform !== "darwin" || arch !== "arm64") return refuse(69, `npm run deploy runs on macOS on Apple silicon only, not ${platform}-${arch}`);
  if (!input.isTTY) return refuse(64, "npm run deploy asks before it changes your Desk: run it in an interactive terminal");
  /** @type {import("../delivery/lib/node-runtime.mjs").NodeRuntime} */
  let runtime;
  try {
    runtime = input.runtime ?? (await readNodeRuntime(root));
  } catch (err) {
    return refuse(65, `npm run deploy: the Node pin is refused (${err instanceof Error ? err.message : String(err)})`);
  }
  if (input.nodeVersion !== runtime.version) {
    return refuse(65, `npm run deploy needs Node ${runtime.version}, the version Desk Terminal pins (this is ${input.nodeVersion}): nvm use`);
  }
  const allowDirty = argv.includes("--allow-dirty");
  const stamped = await (input.stamp ?? ((dirty) => stampedVersion({ root, env, allowDirty: dirty })))(allowDirty);
  if (!stamped.ok) {
    warn("npm run deploy: this build is refused; nothing was installed:");
    for (const reason of stamped.reasons) warn(`  ${reason}`);
    return 65;
  }
  const pack =
    input.pack ??
    ((/** @type {VersionInfo} */ version) =>
      packRuntime({ root, out: join(root, "dist"), version, platform, arch, node: process.execPath, runtime, signing: new NodeCodeSigning(), tarball: true }));
  const packed = await pack(stamped.version);
  if (!packed.ok) return refuse(65, `npm run deploy: ${packed.reason}`);
  const code = await (input.install ?? ((dir) => installWithPackedRuntime(dir, platform, env)))(packed.dir);
  if (code !== 0) return code;
  say(`Installed ${stamped.version.version}; run desk`);
  return 0;
}
