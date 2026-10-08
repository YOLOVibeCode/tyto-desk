import { spawn as spawnProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnPty } from "@lydell/node-pty";
import { DESK_COMPAT, TMUX_DESK_LINE, newDeskConfig, serializeDeskConfig } from "../../../packages/core/src/index.ts";
import { NodeCodeSigning } from "../../../packages/node/src/index.ts";
import { readNodeRuntime } from "../../../scripts/delivery/lib/node-runtime.mjs";
import { packRuntime } from "../../../scripts/lib/pack.mjs";
import { waitFor } from "./cdp.ts";
import { saveResult } from "./results.ts";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../fixtures/desk-home", import.meta.url));
/** Every launch's window inside the 1440×900 Xvfb screen, as the other live files use: the user's extraArgs. */
const WINDOW = ["--window-size=1400,860", "--window-position=0,0"];

export type Run = { code: number | null; stdout: string; stderr: string; ms: number };

/** The environment a person's terminal gives the desk launcher: home, display, locale; nothing from Vitest. */
export function userEnv(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    USER: "lab",
    LOGNAME: "lab",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    DISPLAY: process.env.DISPLAY ?? ":99",
    LANG: "C.UTF-8",
    TMPDIR: tmpdir(),
    DESK_IN_CONTAINER: "1",
  };
}

/** Runs a program to its exit with an explicit environment and a budget. */
export function runProgram(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Run> {
  const begun = Date.now();
  return new Promise((resolve) => {
    const child = spawnProcess(file, args, { env, stdio: ["ignore", "pipe", "pipe"], signal: AbortSignal.timeout(timeoutMs) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", () => resolve({ code: null, stdout, stderr, ms: Date.now() - begun }));
    child.once("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - begun }));
  });
}

/** Runs a program on a PTY, answers its `[y/N]` question with `answer`, and returns its exit code and output. */
export async function runAnswering(file: string, args: string[], env: NodeJS.ProcessEnv, answer: "y" | "n"): Promise<{ code: number; output: string }> {
  const child = spawnPty(file, args, { name: "xterm-256color", cols: 120, rows: 30, cwd: env.HOME ?? tmpdir(), env });
  let output = "";
  child.onData((data) => (output += data));
  const exited = new Promise<number>((resolve) => child.onExit((exit) => resolve(exit.exitCode)));
  await waitFor(() => output.includes("[y/N]"), { label: `${args.join(" ")}'s question`, timeoutMs: 30_000 });
  child.write(`${answer}\r`);
  return { code: await exited, output: output.replace(/\r/g, "") };
}

/** An installed Desk in a fresh home: its home, its DESK_HOME, and its `desk` launcher run as the operator runs it. */
export type InstalledDesk = {
  home: string;
  deskHome: string;
  desk(args?: string[], timeoutMs?: number): Promise<Run>;
  /** Packs this checkout as `version` and installs it with the installed `desk install --from`, answering yes. */
  installVersion(version: string): Promise<{ code: number; output: string }>;
};

/**
 * Packs this checkout as a dev runtime with the test hooks, installs it into a fresh home through the packed runtime's
 * own `desk install` (answered on a PTY), and writes a config whose Chrome takes `port` and the guarded endpoint the next
 * one. The home has the fixture zsh dotfiles and Desk's tmux line, as `desk install` adds it with consent (slice 4b).
 */
export async function installDesk(options: { port: number; resultTag: string }): Promise<InstalledDesk> {
  const home = await mkdtemp(join(tmpdir(), `${options.resultTag}-home-`));
  const deskHome = join(home, ".desk");
  await copyFile(join(FIXTURES, "zprofile"), join(home, ".zprofile"));
  await copyFile(join(FIXTURES, "zshrc"), join(home, ".zshrc"));
  await writeFile(join(home, ".tmux.conf"), `${TMUX_DESK_LINE}\n`);
  const config = newDeskConfig({ home, platform: "linux", chromePort: options.port, gatewayPort: options.port + 1 });
  await mkdir(deskHome, { recursive: true, mode: 0o700 });
  await writeFile(join(deskHome, "config.json"), serializeDeskConfig({ ...config, chrome: { ...config.chrome, extraArgs: WINDOW } }), { mode: 0o600 });

  const packed = await packVersion("0.0.1-dev.live+0000000", options.resultTag);

  const installed = await runAnswering(
    join(packed.dir, "node", "desk-node"),
    [join(packed.dir, "desk.mjs"), "install", "--from", packed.dir],
    { HOME: home, DESK_HOME: deskHome, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TMPDIR: tmpdir() },
    "y",
  );
  await saveResult(`${options.resultTag}-install`, installed);
  if (installed.code !== 0) throw new Error(`desk install exited ${installed.code}`);

  const launcher = join(home, ".local", "bin", "desk");
  return {
    home,
    deskHome,
    desk: (args = [], timeoutMs = 90_000) => runProgram(launcher, args, userEnv(home), timeoutMs),
    installVersion: async (version) => {
      const next = await packVersion(version, `${options.resultTag}-next`);
      return runAnswering(launcher, ["install", "--from", next.dir], userEnv(home), "y");
    },
  };
}

/** This checkout packed as a linux runtime of `version` (a dev build unless told), with the test hooks. */
export async function packVersion(
  version: string,
  tag: string,
  options: { channel?: "dev" | "stable"; commit?: string; tarball?: boolean } = {},
): Promise<{ dir: string; tarball: string | null }> {
  const out = await mkdtemp(join(tmpdir(), `${tag}-dist-`));
  const packed = await packRuntime({
    root: repo,
    out,
    version: {
      version,
      channel: options.channel ?? "dev",
      branch: options.channel === "stable" ? null : "live",
      commit: options.commit ?? "0".repeat(40),
      dirty: false,
      builtAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      node: "26.10.0",
      compat: DESK_COMPAT,
    },
    platform: "linux",
    arch: process.arch,
    node: process.execPath,
    runtime: await readNodeRuntime(repo),
    signing: new NodeCodeSigning("/nonexistent/codesign"),
    tarball: options.tarball ?? false,
    testHooks: true,
  });
  if (!packed.ok) throw new Error(`pack failed: ${packed.reason}`);
  return { dir: packed.dir, tarball: packed.tarball };
}
