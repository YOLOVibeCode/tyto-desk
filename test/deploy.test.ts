import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DESK_COMPAT, type VersionInfo } from "../packages/core/src/index.ts";
import { FakePortProbe, ScriptedPrompter, SeqRandom } from "../packages/core/src/testing/index.ts";
import { installCommand } from "../packages/cli/src/index.ts";
import { NodeCodeSigning, TestIsolationError } from "../packages/node/src/index.ts";
import { deploy } from "../scripts/lib/deploy.mjs";
import { packRuntime, type PackResult } from "../scripts/lib/pack.mjs";
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

/** What a program the operator never wants deploy to start records, from a stub of the same name on PATH. */
async function guiStubs(): Promise<{ bin: string; ran: string }> {
  const bin = await mkdtemp(join(tmpdir(), "gui-stubs-"));
  const ran = join(bin, "ran.log");
  for (const name of ["open", "osascript", "google-chrome", "google-chrome-stable", "chromium"]) {
    await writeFile(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> '${ran}'\n`);
    await chmod(join(bin, name), 0o755);
  }
  return { bin, ran };
}

/** A test that may make the file's one pack (esbuild bundles desk.mjs and the extension) gets this long. */
const PACK_MS = 20_000;

type SharedPack = {
  runtime: { version: string; platforms: Record<string, { archive: string; archiveSha256: string; binarySha256: string }> };
  codesign: string;
  pack: (stamped: VersionInfo) => Promise<PackResult>;
  /** What the packed Desk Terminal last recorded, and the exit code it gives next. */
  record: string;
  exitWith(code: number): Promise<void>;
};

let shared: Promise<SharedPack> | null = null;

/**
 * One pack of this checkout for the file, as deploy's `pack` step (it writes only the run's temporary directory). Its
 * Desk Terminal, pinned by its sha256 and signed by a stub codesign, records the argv and the environment it was
 * started with, then exits with the code the test set.
 */
function sharedPack(): Promise<SharedPack> {
  shared ??= (async () => {
    const control = await mkdtemp(join(tmpdir(), "terminal-control-"));
    const record = join(control, "record.json");
    const exitFile = join(control, "exit");
    const nodeText = [
      `#!${process.execPath}`,
      `import("node:fs").then((fs) => {`,
      `  const code = Number(fs.readFileSync(${JSON.stringify(exitFile)}, "utf8"));`,
      `  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));`,
      `  process.exit(code);`,
      `});`,
      "",
    ].join("\n");
    const node = join(control, "node");
    await writeFile(node, nodeText);
    await chmod(node, 0o755);
    const runtime = { version: "26.10.0", platforms: { "darwin-arm64": { archive: "node.tar.gz", archiveSha256: "0".repeat(64), binarySha256: sha256(nodeText) } } };
    const codesign = await fakeExecutable("codesign", []);
    const modules = await ptyPackages("darwin");
    const out = await mkdtemp(join(tmpdir(), "deploy-dist-"));
    let packed: Promise<PackResult> | null = null;
    return {
      runtime,
      codesign: codesign.path,
      pack: (stamped: VersionInfo) =>
        (packed ??= packRuntime({
          root: repo,
          out,
          version: stamped,
          platform: "darwin",
          arch: "arm64",
          node,
          runtime,
          signing: new NodeCodeSigning(codesign.path),
          tarball: false,
          nodeModules: modules,
        })),
      record,
      exitWith: async (code: number) => {
        await rm(record, { force: true });
        await writeFile(exitFile, String(code));
      },
    };
  })();
  return shared;
}

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

  it("npm run deploy runs the packed Desk Terminal's own desk install --from <dir>, with an allowlisted environment, and nothing else", async () => {
    const packed = await sharedPack();
    await packed.exitWith(0);
    const stubs = await guiStubs();
    const deskHome = process.env.DESK_HOME ?? "";
    const env = {
      HOME: process.env.HOME ?? "",
      DESK_HOME: deskHome,
      PATH: `${stubs.bin}:/usr/bin:/bin`,
      TMPDIR: tmpdir(),
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      USER: "alex",
      LOGNAME: "alex",
      NODE_OPTIONS: "--require /nonexistent/evil.js",
      NODE_PATH: "/nonexistent",
      DESK_ALLOW_GUI: "1",
      ELECTRON_RUN_AS_NODE: "1",
      UNRELATED: "x",
    };
    const out = output();

    const code = await deploy({ argv: [], env, root: repo, runtime: packed.runtime, ...mac, stamp: async () => ({ ok: true, version }), pack: packed.pack, ...out });

    const ran = JSON.parse(await readFile(packed.record, "utf8")) as { argv: string[]; env: Record<string, string> };
    const dir = ran.argv[0]?.replace(/\/desk\.mjs$/, "") ?? "";
    expect(code).toBe(0);
    expect(dir).toMatch(new RegExp(`/desk-${version.version.replace(/[.+]/g, "\\$&")}$`));
    expect(ran.argv).toEqual([join(dir, "desk.mjs"), "install", "--from", dir]);
    expect(Object.keys(ran.env).filter((name) => !name.startsWith("__CF_")).sort()).toEqual(["DESK_HOME", "HOME", "LANG", "LOGNAME", "PATH", "TERM", "TMPDIR", "USER"]);
    expect(ran.env.DESK_HOME).toBe(deskHome);
    expect(out.lines).toContain(`Installed ${version.version}; run desk`);
    expect(await exists(stubs.ran)).toBe(false);
  }, PACK_MS);

  it("npm run deploy stops with the exit code of the packed desk install and never says Installed", async () => {
    const packed = await sharedPack();
    await packed.exitWith(77);
    const out = output();

    const code = await deploy({
      argv: [],
      env: { HOME: process.env.HOME ?? "", DESK_HOME: process.env.DESK_HOME ?? "", PATH: "/usr/bin:/bin" },
      root: repo,
      runtime: packed.runtime,
      ...mac,
      stamp: async () => ({ ok: true, version }),
      pack: packed.pack,
      ...out,
    });

    expect(code).toBe(77);
    expect(await exists(packed.record)).toBe(true);
    expect(out.lines.join("\n")).not.toContain("Installed");
  }, PACK_MS);

  it("npm run deploy asks on a TTY, installs into DESK_HOME/app/<version>, switches current and never starts Chrome", async () => {
    const deskHome = process.env.DESK_HOME ?? "";
    const home = process.env.HOME ?? "";
    const packed = await sharedPack();
    const stubs = await guiStubs();
    const prompter = new ScriptedPrompter([true]);
    const installedFrom: string[] = [];
    const out = output();

    const code = await deploy({
      argv: [],
      env: { HOME: home, DESK_HOME: deskHome, PATH: `${stubs.bin}:/usr/bin:/bin` },
      root: repo,
      runtime: packed.runtime,
      ...mac,
      stamp: async () => ({ ok: true, version }),
      pack: packed.pack,
      // The packed runtime's own install, run here with a scripted answer instead of the operator's terminal.
      install: async (dir: string) => {
        installedFrom.push(dir);
        return (
          await installCommand({
            from: dir,
            deskHome,
            home,
            platform: "darwin",
            prompter,
            channel: "dev",
            probe: new FakePortProbe(),
            random: new SeqRandom([7]),
            codesign: packed.codesign,
          })
        ).code;
      },
      ...out,
    });

    expect(code).toBe(0);
    expect(installedFrom).toHaveLength(1);
    expect(prompter.asked).toHaveLength(1);
    expect(await exists(join(deskHome, "app", version.version, "desk.mjs"))).toBe(true);
    expect(await readlink(join(deskHome, "app", "current"))).toBe(version.version);
    expect(out.lines).toContain(`Installed ${version.version}; run desk`);
    expect(await exists(stubs.ran)).toBe(false);
  }, PACK_MS);

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
