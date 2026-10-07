import { spawn as spawnProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnPty } from "@lydell/node-pty";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESK_COMPAT, DESK_EXTENSION_ID, TMUX_DESK_LINE, newDeskConfig, serializeDeskConfig, type Panes } from "../../packages/core/src/index.ts";
import { DaemonExtensionBridge, UnixDaemonClient } from "../../packages/cli/src/index.ts";
import { NodeCodeSigning } from "../../packages/node/src/index.ts";
import { readNodeRuntime } from "../../scripts/delivery/lib/node-runtime.mjs";
import { packRuntime } from "../../scripts/lib/pack.mjs";
import { Cdp, attach, evaluate, targets, waitFor, type TargetInfo } from "./lib/cdp.ts";
import { browserVersion } from "./lib/chrome.ts";
import { startFixtureServer, type FixtureServer } from "./lib/fixture-server.ts";
import { LIVE_PORTS } from "./lib/ports.ts";
import { saveResult, saveScreenshot } from "./lib/results.ts";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/desk-home", import.meta.url));
const PORT = LIVE_PORTS.desk;
const PANEL_URL = `chrome-extension://${DESK_EXTENSION_ID}/panel.html`;
const WORKER_URL = `chrome-extension://${DESK_EXTENSION_ID}/sw.js`;
/** Every launch's window inside the 1440×900 Xvfb screen, as the other live files use: the user's extraArgs. */
const WINDOW = ["--window-size=1400,860", "--window-position=0,0"];
const IDLE_MS = 5 * 60_000;

type Run = { code: number | null; stdout: string; stderr: string; ms: number };

/** What beforeAll set up; each test reads it through `desk()`, which fails clearly when the setup did not finish. */
type Desk = {
  home: string;
  deskHome: string;
  cdp: Cdp;
  launch: Run;
  shellMs: number;
  panel: TargetInfo;
  panelSession: string;
  pane: string;
  daemon: UnixDaemonClient;
};

let started: Desk | undefined;
let fixture: FixtureServer | undefined;

function desk(): Desk {
  if (started === undefined) throw new Error("Desk did not start (see the beforeAll failure)");
  return started;
}

/** The environment a person's terminal gives the desk launcher: home, display, locale; nothing from Vitest. */
function userEnv(home: string): NodeJS.ProcessEnv {
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
function runProgram(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Run> {
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

/** The daemon's pane list, through a client of kind cli on its socket. */
async function panes(daemon: UnixDaemonClient): Promise<Panes | null> {
  const opened = await daemon.open("cli");
  if (!opened.ok) return null;
  try {
    const reply = await opened.session.request({ type: "list" });
    return reply?.type === "panes" ? reply : null;
  } finally {
    opened.session.close();
  }
}

/** The pane's screen as the panel's terminal shows it (the test build's hook). */
function screen(): Promise<string> {
  const { cdp, panelSession, pane } = desk();
  return evaluate<string>(cdp, panelSession, `deskTest.screen(${JSON.stringify(pane)})`);
}

/** Types a command into the panel's terminal and presses Enter, as a person would. */
async function typeLine(text: string): Promise<void> {
  const { cdp, panelSession } = desk();
  await evaluate(cdp, panelSession, "document.querySelector('textarea.xterm-helper-textarea')?.focus(), true");
  await cdp.send("Input.insertText", { text }, { sessionId: panelSession });
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send(
      "Input.dispatchKeyEvent",
      { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) },
      { sessionId: panelSession },
    );
  }
}

/** The CDP window of a target. */
async function windowOf(targetId: string): Promise<number> {
  return (await desk().cdp.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId })).windowId;
}

describe("Desk's walking skeleton in the live container", () => {
  beforeAll(async () => {
    const home = await mkdtemp(join(tmpdir(), "desk-home-"));
    const deskHome = join(home, ".desk");
    await copyFile(join(FIXTURES, "zprofile"), join(home, ".zprofile"));
    await copyFile(join(FIXTURES, "zshrc"), join(home, ".zshrc"));
    // Desk's tmux line, as desk install adds it with consent (slice 4b): the agent-variable gate lets panes carry them.
    await writeFile(join(home, ".tmux.conf"), `${TMUX_DESK_LINE}\n`);
    const config = newDeskConfig({ home, platform: "linux", chromePort: PORT, gatewayPort: PORT + 1 });
    await mkdir(deskHome, { recursive: true, mode: 0o700 });
    await writeFile(join(deskHome, "config.json"), serializeDeskConfig({ ...config, chrome: { ...config.chrome, extraArgs: WINDOW } }), { mode: 0o600 });

    const out = await mkdtemp(join(tmpdir(), "desk-dist-"));
    const packed = await packRuntime({
      root: repo,
      out,
      version: {
        version: "0.0.1-dev.live+0000000",
        channel: "dev",
        branch: "live",
        commit: "0".repeat(40),
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
      tarball: false,
      testHooks: true,
    });
    if (!packed.ok) throw new Error(`pack failed: ${packed.reason}`);

    // The packed runtime's own desk install, which asks on its terminal: the test answers through a PTY.
    const installer = spawnPty(join(packed.dir, "node", "desk-node"), [join(packed.dir, "desk.mjs"), "install", "--from", packed.dir], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: home,
      env: { HOME: home, DESK_HOME: deskHome, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TMPDIR: tmpdir() },
    });
    let installed = "";
    installer.onData((data) => (installed += data));
    const installExit = new Promise<number>((resolve) => installer.onExit((exit) => resolve(exit.exitCode)));
    await waitFor(() => installed.includes("[y/N]"), { label: "desk install's question", timeoutMs: 30_000 });
    installer.write("y\r");
    const installCode = await installExit;
    await saveResult("desk-install", { code: installCode, output: installed.replace(/\r/g, "") });
    if (installCode !== 0) throw new Error(`desk install exited ${installCode}`);

    // Cold launch: no Chrome, a fresh profile, the installed launcher, as the operator runs desk.
    const launchedAt = Date.now();
    const launch = await runProgram(join(home, ".local", "bin", "desk"), [], userEnv(home), 90_000);
    await saveResult("desk-launch-output", launch);
    if (launch.code !== 0) throw new Error(`desk exited ${launch.code}: ${launch.stderr.trim()}`);

    const version = await browserVersion(PORT);
    const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    const panel = await waitFor(async () => (await targets(cdp)).find((t) => t.url === PANEL_URL), { label: "the Desk panel" });
    const panelSession = await attach(cdp, panel.targetId);
    const pane = await waitFor(
      () => evaluate<string | null>(cdp, panelSession, "typeof deskTest === 'object' && deskTest.panes().length > 0 ? deskTest.panes()[0] : null"),
      { label: "the panel's pane", intervalMs: 20 },
    );
    await waitFor(async () => (await evaluate<string>(cdp, panelSession, `deskTest.screen(${JSON.stringify(pane)})`)).includes("desk-live %"), {
      label: "the shell's prompt in the panel",
      intervalMs: 20,
      timeoutMs: 30_000,
    });
    const shellMs = Date.now() - launchedAt;
    started = { home, deskHome, cdp, launch, shellMs, panel, panelSession, pane, daemon: new UnixDaemonClient(join(deskHome, "run", "ptyd.sock"), "live") };
    await saveResult("desk-cold-launch", { launcherMs: launch.ms, shellMs, ready: launch.stdout.trim() });
  }, 240_000);

  afterAll(async () => {
    await fixture?.close();
    if (started === undefined) return;
    const { cdp, deskHome } = started;
    await cdp.send("Browser.close").catch(() => undefined);
    await waitFor(async () => !(await browserVersion(PORT).then(() => true, () => false)), { label: "Chrome's exit", timeoutMs: 10_000 }).catch(() => undefined);
    cdp.close();
    // The daemon lives until a shutdown (§7.1); this run's daemon gets one, as desk quit --all will send it.
    await new Promise<void>((resolve) => {
      const socket = connect({ path: join(deskHome, "run", "ptyd.sock") });
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ type: "hello", vMin: 1, vMax: 1, client: "cli", build: "live" })}\n`);
        socket.write(`${JSON.stringify({ type: "shutdown", mode: "stop" })}\n`);
        socket.end();
        resolve();
      });
      socket.once("error", () => resolve());
    });
  }, 60_000);

  it("desk launches the installed version cold and prints Desk ready with its port and Chrome", () => {
    const { launch, shellMs } = desk();

    expect(launch.stdout.trim()).toMatch(new RegExp(`^Desk ready \\(port ${PORT}, guarded ${PORT + 1}, Chrome \\d+\\.\\d+\\.\\d+\\.\\d+\\) in \\d+\\.\\d s$`));
    expect(shellMs).toBeGreaterThan(0);
  });

  it("typing echo desk-ok in the panel prints desk-ok", async () => {
    await typeLine("echo desk-ok");
    const shown = await waitFor(async () => {
      const text = await screen();
      return text.split("\n").some((line) => line.trim() === "desk-ok") ? text : null;
    }, { label: "desk-ok on the panel's screen" });
    const { cdp, panelSession } = desk();
    await saveScreenshot("desk-echo", (await cdp.send<{ data: string }>("Page.captureScreenshot", {}, { sessionId: panelSession })).data);
    await saveResult("desk-echo", { screen: shown });

    expect(shown).toContain("desk-live % echo desk-ok");
  });

  it("agent-browser open <fixture> typed in the pane opens a tab in the Desk window", async () => {
    fixture = await startFixtureServer();
    const url = `${fixture.origin}/page1.html`;
    const { cdp, daemon, pane } = desk();

    await typeLine(`echo "session=$AGENT_BROWSER_SESSION"; agent-browser open ${url}`);
    const page = await waitFor(async () => (await targets(cdp)).find((t) => t.type === "page" && t.url === url), {
      label: "the fixture's tab",
      timeoutMs: 45_000,
    }).finally(async () => saveResult("desk-agent-browser-screen", { screen: await screen().catch(() => "unreadable") }));
    const listed = await panes(daemon);
    const panelWindow = listed?.panels[0]?.window;
    const text = await screen();
    await saveResult("desk-agent-browser", { page: page.url, pageWindow: await windowOf(page.targetId), panelWindow, screen: text });

    expect(text).toContain(`session=desk-${pane}`);
    expect(await windowOf(page.targetId)).toBe(panelWindow);
  });

  it("the panel opens in the window whose tab target the action was triggered on", async () => {
    const { cdp, daemon } = desk();
    const { targetId: page } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", newWindow: true });
    const second = await windowOf(page);
    const tabs = (await cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets", { filter: [{ type: "tab" }] })).targetInfos;
    let tab: string | undefined;
    let kind = "tab";
    for (const candidate of tabs) if ((await windowOf(candidate.targetId).catch(() => -1)) === second) tab = candidate.targetId;
    if (tab === undefined) {
      // Chrome may not place tab targets in windows; the page target's web contents are the same tab (CdpPanelOpener).
      kind = "page";
      tab = page;
    }

    await cdp.send("Extensions.triggerAction", { id: DESK_EXTENSION_ID, targetId: tab });
    const listed = await waitFor(async () => {
      const now = await panes(daemon);
      return now?.panels.some((panel) => panel.window === second) ? now : null;
    }, { label: `a panel hello from window ${second}` });
    await saveResult("desk-panel-window", { second, kind, panels: listed.panels });

    expect(listed.panels.map((panel) => panel.window)).toContain(second);
  });

  it(
    "the service worker is still connected to the daemon after 5 minutes idle",
    async () => {
      const { cdp, daemon } = desk();
      const before = await panes(daemon);
      if (before === null) throw new Error("the daemon did not answer");

      // Five idle minutes: nothing talks to the worker, and an MV3 worker without a native port ends after 30 s.
      await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
      const after = await panes(daemon);
      const worker = (await targets(cdp)).find((t) => t.type === "service_worker" && t.url === WORKER_URL);
      const windows = await new DaemonExtensionBridge(daemon).windows();
      await saveResult("desk-worker-idle", { before: before.sw, after: after?.sw, worker: worker?.url ?? null, windows });

      expect(before.sw).toEqual({ connected: true, connects: 1 });
      expect(after?.sw).toEqual({ connected: true, connects: 1 });
      expect(worker?.url).toBe(WORKER_URL);
      expect(windows?.length).toBeGreaterThan(0);
    },
    IDLE_MS + 120_000,
  );
});
