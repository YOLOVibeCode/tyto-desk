import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DESK_COMPAT, parseFilesSha256 } from "../packages/core/src/index.ts";
import { NodeCodeSigning } from "../packages/node/src/index.ts";
import { packRuntime } from "../scripts/lib/pack.mjs";
import { fakeExecutable } from "./fixtures/fake-exec.ts";
import { ptyPackages } from "./fixtures/pty-packages.ts";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const version = {
  version: "0.3.1-dev.slice-1c-walking-skeleton+a1b2c3d",
  channel: "dev",
  branch: "slice-1c/walking-skeleton",
  commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  dirty: false,
  builtAt: "2026-10-07T09:00:00Z",
  node: "26.10.0",
  compat: DESK_COMPAT,
};

/** A stand-in for the Node binary, and a pin that names its sha256 for darwin-arm64 and linux-arm64. */
async function fakeNode(text = "#!/bin/sh\necho fake-node\n") {
  const dir = await mkdtemp(join(tmpdir(), "fake-node-"));
  const path = join(dir, "node");
  await writeFile(path, text);
  await chmod(path, 0o755);
  const pin = { archive: "node.tar.gz", archiveSha256: "0".repeat(64), binarySha256: sha256(text) };
  return { path, runtime: { version: "26.10.0", source: "https://nodejs.org/dist/v26.10.0/", platforms: { "darwin-arm64": pin, "linux-arm64": pin } } };
}

async function pack(platform: string, options: { node?: Awaited<ReturnType<typeof fakeNode>>; tarball?: boolean } = {}) {
  const node = options.node ?? (await fakeNode());
  const codesign = await fakeExecutable("codesign", []);
  const out = await mkdtemp(join(tmpdir(), "dist-"));
  const result = await packRuntime({
    root: repo,
    out,
    version,
    platform,
    arch: "arm64",
    node: node.path,
    runtime: node.runtime,
    signing: new NodeCodeSigning(codesign.path),
    tarball: options.tarball ?? true,
    nodeModules: await ptyPackages(platform),
  });
  return { result, out, codesign };
}

/** Every file under `dir`, relative and `/`-separated. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();
}

describe("npm run pack", () => {
  it("npm run pack writes the release-shaped tarball with version.json, files.sha256, the PTY package and Desk Terminal", async () => {
    const { result, out } = await pack("darwin");
    if (!result.ok) throw new Error(result.reason);
    const dir = join(out, `desk-${version.version}`);
    const files = await filesUnder(dir);
    const listed = await run("tar", ["-tzf", join(out, `desk-${version.version}-darwin-arm64.tar.gz`)]);

    expect(result.dir).toBe(dir);
    expect(JSON.parse(await readFile(join(dir, "version.json"), "utf8"))).toEqual(version);
    expect(files).toEqual(
      expect.arrayContaining([
        "version.json",
        "files.sha256",
        "desk.mjs",
        "Desk Terminal.app/Contents/Info.plist",
        "Desk Terminal.app/Contents/MacOS/desk-node",
        "extension/manifest.json",
        "extension/panel.html",
        "extension/panel.css",
        "extension/panel.js",
        "extension/sw.js",
        "extension/xterm.css",
        "node_modules/@lydell/node-pty/index.js",
        "node_modules/@lydell/node-pty/package.json",
        "node_modules/@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/pty.node",
        "node_modules/@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/spawn-helper",
      ]),
    );
    expect(listed.stdout.split("\n")).toEqual(expect.arrayContaining([`desk-${version.version}/desk.mjs`, `desk-${version.version}/files.sha256`]));
    expect((await stat(join(dir, "node_modules/@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/spawn-helper"))).mode & 0o111).not.toBe(0);
    expect((await stat(join(dir, "Desk Terminal.app/Contents/MacOS/desk-node"))).mode & 0o111).not.toBe(0);
  });

  it("files.sha256 lists every other file of the runtime with its sha256, and the build id is its own sha256", async () => {
    const { result } = await pack("linux", { tarball: false });
    if (!result.ok) throw new Error(result.reason);
    const text = await readFile(join(result.dir, "files.sha256"), "utf8");
    const listed = parseFilesSha256(text);
    const files = (await filesUnder(result.dir)).filter((path) => path !== "files.sha256");

    expect([...(listed?.keys() ?? [])].sort()).toEqual(files);
    for (const path of files) expect(listed?.get(path)).toBe(sha256(await readFile(join(result.dir, path))));
    expect(result.build).toBe(sha256(text));
    expect(result.tarball).toBeNull();
  });

  it("on Linux, Desk Terminal is node/desk-node, unsigned", async () => {
    const { result, codesign } = await pack("linux", { tarball: false });
    if (!result.ok) throw new Error(result.reason);

    expect(await filesUnder(result.dir)).toContain("node/desk-node");
    expect(await codesign.calls()).toEqual([]);
  });

  it("the runtime build signs Desk Terminal ad hoc with its own identifier", async () => {
    const { result, codesign } = await pack("darwin", { tarball: false });
    if (!result.ok) throw new Error(result.reason);
    const app = join(result.dir, "Desk Terminal.app");

    expect((await codesign.calls()).map((call) => call.argv)).toEqual([
      ["--force", "--sign", "-", "--identifier", "com.noctusoft.desk.terminal", "--timestamp=none", app],
    ]);
    const plist = await readFile(join(app, "Contents", "Info.plist"), "utf8");
    expect(plist).toContain("<key>CFBundleIdentifier</key>\n  <string>com.noctusoft.desk.terminal</string>");
    expect(plist).toContain("<key>LSUIElement</key>\n  <true/>");
    expect(plist).not.toMatch(/CFBundleShortVersionString|<key>CFBundleVersion<\/key>/);
  });

  it("the runtime build refuses a Node binary whose sha256 differs from the pinned one", async () => {
    const node = await fakeNode();
    await writeFile(node.path, "#!/bin/sh\necho a different node\n");

    const { result, out } = await pack("darwin", { node });

    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/is not the pinned Node 26\.10\.0/) });
    expect(await readdir(out)).toEqual([]);
  });

  it.each([
    ["darwin", "x64"],
    ["linux", "x64"],
  ])("the runtime build refuses %s-%s, which has no pinned Node", async (platform, arch) => {
    const node = await fakeNode();
    const out = await mkdtemp(join(tmpdir(), "dist-"));

    const result = await packRuntime({ root: repo, out, version, platform, arch, node: node.path, runtime: node.runtime, signing: new NodeCodeSigning("/nonexistent"), tarball: false });

    expect(result).toEqual({ ok: false, reason: `Desk Terminal has no pinned Node for ${platform}-${arch}` });
  });

  it("the runtime's extension is the production build, without the live suite's test hooks", async () => {
    const { result } = await pack("linux", { tarball: false });
    if (!result.ok) throw new Error(result.reason);

    expect(await readFile(join(result.dir, "extension", "panel.js"), "utf8")).not.toContain("deskTest");
  });
});
