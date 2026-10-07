import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, readlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DESK_COMPAT, type VersionInfo } from "../packages/core/src/index.ts";
import { FakePortProbe, ScriptedPrompter, SeqRandom } from "../packages/core/src/testing/index.ts";
import { installCommand } from "../packages/cli/src/index.ts";
import { NodeCodeSigning, TestIsolationError } from "../packages/node/src/index.ts";
import { deploy } from "../scripts/lib/deploy.mjs";
import { packRuntime } from "../scripts/lib/pack.mjs";
import { gitCheckout, gitEnv } from "./delivery/helpers.ts";
import { fakeExecutable } from "./fixtures/fake-exec.ts";
import { ptyPackages } from "./fixtures/pty-packages.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const exists = (path: string) => access(path).then(() => true, () => false);

const version: VersionInfo = {
  version: "0.3.1-dev.slice-1c-walking-skeleton+a1b2c3d",
  channel: "dev",
  branch: "slice-1c/walking-skeleton",
  commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  dirty: false,
  builtAt: "2026-10-07T09:00:00Z",
  node: "26.10.0",
  compat: DESK_COMPAT,
};

/** The operator's Mac as deploy sees it: macOS on arm64, an interactive terminal, the pinned Node, no CI or VITEST. */
const mac = { platform: "darwin", arch: "arm64", isTTY: true, nodeVersion: "26.10.0" };
const runtime = { version: "26.10.0", platforms: {} };

function output() {
  const lines: string[] = [];
  return { lines, say: (text: string) => lines.push(text), warn: (text: string) => lines.push(`! ${text}`) };
}

const unreachable = async () => {
  throw new Error("deploy went past its guards");
};

describe("npm run deploy", () => {
  it.each([
    ["CI", { env: { CI: "true" } }],
    ["VITEST", { env: { VITEST: "true" } }],
    ["linux", { platform: "linux" }],
    ["x64", { arch: "x64" }],
  ])("npm run deploy refuses %s", async (_label, change) => {
    const out = output();

    const code = await deploy({ argv: [], env: {}, root: repo, runtime, ...mac, ...change, stamp: unreachable, pack: unreachable, install: unreachable, ...out });

    expect(code).not.toBe(0);
    expect(out.lines.join("\n")).toMatch(/^! /);
  });

  it("npm run deploy refuses without an interactive terminal", async () => {
    const out = output();

    expect(await deploy({ argv: [], env: {}, root: repo, runtime, ...mac, isTTY: false, stamp: unreachable, pack: unreachable, install: unreachable, ...out })).toBe(64);
    expect(out.lines.join("\n")).toContain("interactive terminal");
  });

  it("npm run deploy refuses a Node that is not the pinned 26.10.0", async () => {
    const out = output();

    expect(await deploy({ argv: [], env: {}, root: repo, runtime, ...mac, nodeVersion: "26.9.0", stamp: unreachable, pack: unreachable, install: unreachable, ...out })).toBe(65);
    expect(out.lines.join("\n")).toContain("26.10.0");
  });

  it("npm run deploy refuses a dirty tree unless --allow-dirty", async () => {
    const { root } = await gitCheckout({
      "package.json": `${JSON.stringify({ name: "x", version: "0.3.0" })}\n`,
      ".nvmrc": "26.10.0\n",
      ".gitignore": "dist/\n",
      "scripts/delivery/node-runtime.json": `${JSON.stringify(runtime)}\n`,
    });
    await writeFile(join(root, "uncommitted.txt"), "work in progress\n");
    const packed: string[] = [];
    const pack = async (stamped: VersionInfo) => {
      packed.push(stamped.version);
      return { ok: false as const, reason: "stop here" };
    };

    const refused = await deploy({ argv: [], env: gitEnv, root, runtime, ...mac, pack, install: unreachable, ...output() });
    const allowed = await deploy({ argv: ["--allow-dirty"], env: gitEnv, root, runtime, ...mac, pack, install: unreachable, ...output() });

    expect(refused).toBe(65);
    expect(allowed).toBe(65);
    expect(packed).toEqual([expect.stringMatching(/^0\.3\.1-dev\.main\+[0-9a-f]{7}\.dirty\.\d{8}t\d{6}z$/)]);
  });

  it("npm run deploy asks on a TTY, installs into DESK_HOME/app/<version>, switches current and never starts Chrome", async () => {
    const deskHome = process.env.DESK_HOME ?? "";
    const home = process.env.HOME ?? "";
    const ran = join(await mkdtemp(join(tmpdir(), "desk-terminal-ran-")), "ran");
    const nodeText = `#!/bin/sh\necho ran > '${ran}'\n`;
    const node = join(await mkdtemp(join(tmpdir(), "fake-node-")), "node");
    await writeFile(node, nodeText);
    await chmod(node, 0o755);
    const pin = { archive: "node.tar.gz", archiveSha256: "0".repeat(64), binarySha256: sha256(nodeText) };
    const fakeRuntime = { version: "26.10.0", platforms: { "darwin-arm64": pin } };
    const codesign = await fakeExecutable("codesign", []);
    const modules = await ptyPackages("darwin");
    const prompter = new ScriptedPrompter([true]);
    const out = output();

    const code = await deploy({
      argv: [],
      env: { HOME: home, DESK_HOME: deskHome },
      root: repo,
      runtime: fakeRuntime,
      ...mac,
      stamp: async () => ({ ok: true, version }),
      pack: (stamped: VersionInfo) =>
        packRuntime({
          root: repo,
          out: join(tmpdir(), `deploy-dist-${process.pid}`),
          version: stamped,
          platform: "darwin",
          arch: "arm64",
          node,
          runtime: fakeRuntime,
          signing: new NodeCodeSigning(codesign.path),
          tarball: false,
          nodeModules: modules,
        }),
      install: async (dir: string) =>
        (
          await installCommand({
            from: dir,
            deskHome,
            home,
            platform: "darwin",
            prompter,
            channel: "dev",
            probe: new FakePortProbe(),
            random: new SeqRandom([7]),
            codesign: codesign.path,
          })
        ).code,
      ...out,
    });

    expect(code).toBe(0);
    expect(prompter.asked).toHaveLength(1);
    expect(await exists(join(deskHome, "app", version.version, "desk.mjs"))).toBe(true);
    expect(await readlink(join(deskHome, "app", "current"))).toBe(version.version);
    expect(out.lines).toContain(`Installed ${version.version}; run desk`);
    expect(await exists(ran)).toBe(false);
  });

  it("npm run deploy keeps the real home refused: the installed version goes only into the run's fresh DESK_HOME", async () => {
    const realHome = process.env.DESK_TEST_REAL_HOME ?? userInfo().homedir;
    const probe = join(realHome, ".desk-test-guard-probe", ".desk");

    const refused = installCommand({
      from: join(tmpdir(), "no-runtime"),
      deskHome: probe,
      home: join(realHome, ".desk-test-guard-probe"),
      platform: "darwin",
      prompter: new ScriptedPrompter([true]),
      channel: "dev",
      probe: new FakePortProbe(),
      random: new SeqRandom([7]),
    });

    await expect(refused).rejects.toBeInstanceOf(TestIsolationError);
  });
});
