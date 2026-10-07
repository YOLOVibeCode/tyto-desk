/**
 * The runtime build (docs/IMPLEMENTATION.md §15.1, §23.4, §23.6): `dist/desk-<version>/`, the release-shaped directory
 * an install takes, and its tarball `dist/desk-<version>-<platform>-<arch>.tar.gz`. It holds version.json (the stamp's),
 * desk.mjs and its chunks, the extension (its manifest still a template: every launch renders it), the PTY package with
 * its platform prebuild, Desk Terminal (the pinned Node: on macOS `Desk Terminal.app`, signed ad hoc as
 * com.noctusoft.desk.terminal; on Linux `node/desk-node`, unsigned), and files.sha256 over all of it. It runs esbuild and
 * the repo's own code only; no dev tool runs while it packs.
 */
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FILES_SHA256, formatFilesSha256 } from "../../packages/core/src/index.ts";
import { fileSha256, runArgv } from "../../packages/node/src/index.ts";
import { nodePin } from "../delivery/lib/node-runtime.mjs";
import { buildBundles } from "./build.mjs";

/** @typedef {import("../delivery/lib/node-runtime.mjs").NodeRuntime} NodeRuntime */
/** @typedef {import("../../packages/core/src/index.ts").CodeSigning} CodeSigning */
/** @typedef {{ ok: true; dir: string; tarball: string | null; build: string } | { ok: false; reason: string }} PackResult */

/** Desk Terminal's bundle identifier (§15.1): privacy prompts and grants name it, not every `node`. */
export const TERMINAL_IDENTIFIER = "com.noctusoft.desk.terminal";

/** Desk Terminal's Info.plist: its identifier, no Dock icon, and no Desk version, so its signature outlives updates (§23.5 rule 8). */
const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${TERMINAL_IDENTIFIER}</string>
  <key>CFBundleName</key>
  <string>Desk Terminal</string>
  <key>CFBundleExecutable</key>
  <string>desk-node</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`;

/** The extension's static files, beside the worker and panel bundles. */
const EXTENSION_FILES = ["manifest.json", "panel.html", "panel.css"];

/**
 * Every file under `dir`, relative and `/`-separated, sorted.
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {Promise<string[]>}
 */
async function filesUnder(dir, prefix = "") {
  /** @type {string[]} */
  const files = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await filesUnder(dir, path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`${path} in the runtime is neither a file nor a directory`);
  }
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * @param {string} path
 * @param {string | Uint8Array} data
 * @param {number} [mode]
 */
async function writeInto(path, data, mode = 0o644) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, data);
  await chmod(path, mode);
}

/**
 * Packs the runtime of the checkout at `root` into `out`.
 * @param {{
 *   root: string;
 *   out: string;
 *   version: { version: string } & Record<string, unknown>;
 *   platform: string;
 *   arch: string;
 *   node: string;
 *   runtime: NodeRuntime;
 *   signing: CodeSigning;
 *   tarball: boolean;
 *   testHooks?: boolean;
 *   nodeModules?: string;
 * }} input
 * @returns {Promise<PackResult>}
 */
export async function packRuntime(input) {
  const { root, out, platform, arch } = input;
  const pin = nodePin(input.runtime, platform, arch);
  if (pin === null) return { ok: false, reason: `Desk Terminal has no pinned Node for ${platform}-${arch}` };
  if ((await fileSha256(input.node)) !== pin.binarySha256) {
    return { ok: false, reason: `${input.node} is not the pinned Node ${input.runtime.version} for ${platform}-${arch} (its sha256 differs)` };
  }
  const name = `desk-${input.version.version}`;
  const dir = join(out, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const { bundles } = await buildBundles(root, { testHooks: input.testHooks === true });
  for (const bundle of bundles) {
    if (bundle.path.startsWith("runtime/")) await writeInto(join(dir, bundle.path.slice("runtime/".length)), bundle.text);
    else if (bundle.path.startsWith("extension/")) await writeInto(join(dir, bundle.path), bundle.text);
  }
  for (const file of EXTENSION_FILES) await writeInto(join(dir, "extension", file), await readFile(join(root, "packages", "extension", file)));
  await writeInto(join(dir, "extension", "xterm.css"), await readFile(join(root, "node_modules", "@xterm", "xterm", "css", "xterm.css")));

  const modules = input.nodeModules ?? join(root, "node_modules");
  for (const pkg of ["@lydell/node-pty", `@lydell/node-pty-${platform}-${arch}`]) {
    await cp(join(modules, pkg), join(dir, "node_modules", pkg), { recursive: true, dereference: true });
  }

  if (platform === "darwin") {
    const app = join(dir, "Desk Terminal.app");
    await writeInto(join(app, "Contents", "Info.plist"), INFO_PLIST);
    await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
    await copyFile(input.node, join(app, "Contents", "MacOS", "desk-node"));
    await chmod(join(app, "Contents", "MacOS", "desk-node"), 0o755);
    if (!(await input.signing.adHocSign(app, TERMINAL_IDENTIFIER))) {
      await rm(dir, { recursive: true, force: true });
      return { ok: false, reason: "codesign could not sign Desk Terminal ad hoc" };
    }
  } else {
    await mkdir(join(dir, "node"), { recursive: true });
    await copyFile(input.node, join(dir, "node", "desk-node"));
    await chmod(join(dir, "node", "desk-node"), 0o755);
  }

  await writeInto(join(dir, "version.json"), `${JSON.stringify(input.version, null, 2)}\n`);
  /** @type {Map<string, string>} */
  const digests = new Map();
  for (const path of await filesUnder(dir)) if (path !== FILES_SHA256) digests.set(path, await fileSha256(join(dir, path)));
  const list = formatFilesSha256(digests);
  await writeInto(join(dir, FILES_SHA256), list);

  let tarball = null;
  if (input.tarball) {
    tarball = join(out, `${name}-${platform}-${arch}.tar.gz`);
    const tar = await runArgv("tar", ["-C", out, "-czf", tarball, name], {
      env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1", LC_ALL: "C" },
      timeoutMs: 5 * 60_000,
    });
    if (tar.code !== 0) return { ok: false, reason: `tar could not write ${tarball}` };
  }
  return { ok: true, dir, tarball, build: createHash("sha256").update(list).digest("hex") };
}
