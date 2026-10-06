import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromeArgs, chromeDefaultDirs, guiAllowed, newDeskConfig } from "../../../packages/core/src/index.ts";
import { Cdp, attach, evaluate, waitFor } from "./cdp.ts";
import { resultsDir } from "./results.ts";

const run = promisify(execFile);

/** Every launch's window, inside the 1440×900 Xvfb screen: Desk passes these as the user's extraArgs. */
const WINDOW = ["--window-size=1400,860", "--window-position=0,0"];

/** The Desk first-run seed (docs/IMPLEMENTATION.md §5): the side panel on the left, 640 px wide. */
const FIRST_RUN_PREFS = { side_panel: { is_right_aligned: false, id_to_width: { kExtension: 640 } } };

/** The ELF binary the google-chrome-stable wrapper execs. */
const CHROME_ELF = "/opt/google/chrome/chrome";

export type Exit = { code: number | null; signal: NodeJS.Signals | null };

export type VersionInfo = { browser: string; webSocketDebuggerUrl: string };

export type LiveChrome = {
  pid: number;
  userDataDir: string;
  /** The browser session. */
  cdp: Cdp;
  /** From the start until /json/version answered. */
  readyMs: number;
  /** `google-chrome-stable --version`. */
  binaryVersion: string;
  /** CDP `Browser.close`, then the process's exit within 10 s. Never a signal (the Chrome law). */
  close(): Promise<Exit>;
};

/** Chrome may start only where the GUI guard allows it: inside the Linux test container, never on the Mac. */
function assertGuiAllowed(): void {
  if (!guiAllowed(process.env, process.platform)) {
    throw new Error("guiAllowed is false here: the live suite starts Chrome only inside the Linux test container");
  }
}

/** Chrome's whole environment: its own HOME, the container's display, nothing inherited. */
function chromeEnv(home: string): NodeJS.ProcessEnv {
  return { HOME: home, PATH: "/usr/bin:/bin", DISPLAY: process.env.DISPLAY ?? ":99", LANG: "C.UTF-8", TZ: "UTC", TMPDIR: tmpdir() };
}

/** Starts a Chrome process with its output in `chrome-<name>.log` among the results. */
async function launch(name: string, file: string, args: readonly string[], home: string) {
  await mkdir(resultsDir(), { recursive: true });
  const log = await open(join(resultsDir(), `chrome-${name}.log`), "a");
  const child = spawn(file, [...args], { env: chromeEnv(home), stdio: ["ignore", log.fd, log.fd] });
  await log.close();
  const exit = new Promise<Exit>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const pid = child.pid;
  if (pid === undefined) throw new Error(`${file} did not start`);
  return { pid, exit, exited: () => child.exitCode !== null || child.signalCode !== null };
}

/** Resolves with `exit`, or rejects when the process has not exited after `timeoutMs`. */
async function exitWithin(exit: Promise<Exit>, timeoutMs: number, what: string): Promise<Exit> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not exit within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([exit, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** `GET /json/version` on the port. */
export async function browserVersion(port: number): Promise<VersionInfo> {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) });
  const body = (await response.json()) as { Browser: string; webSocketDebuggerUrl: string };
  return { browser: body.Browser, webSocketDebuggerUrl: body.webSocketDebuggerUrl };
}

/**
 * Starts the installed Chrome the way Desk will: arguments from core's `chromeArgs` for a fresh Desk config on a fixed
 * port (plus the window geometry as the user's extraArgs), in a fresh profile and HOME, after the GUI guard. Waits for
 * /json/version (polled every 100 ms for up to 20 s, §6.6), then connects to the browser WebSocket.
 */
export async function startDeskChrome(options: {
  name: string;
  port: number;
  urls?: readonly string[];
  /** Write the Desk first-run seed into Default/Preferences first. */
  seedFirstRun?: boolean;
  beforeLaunch?: (userDataDir: string) => Promise<void>;
}): Promise<LiveChrome> {
  assertGuiAllowed();
  const home = await mkdtemp(join(tmpdir(), `${options.name}-home-`));
  const config = newDeskConfig({ home, platform: "linux", chromePort: options.port, gatewayPort: options.port + 1 });
  const chrome = { ...config.chrome, extraArgs: WINDOW };
  await mkdir(chrome.userDataDir, { recursive: true, mode: 0o700 });
  const args = chromeArgs({
    chrome,
    userDataDirReal: await realpath(chrome.userDataDir),
    chromeDefaultDirsReal: chromeDefaultDirs(home, "linux"),
  });
  if (!args.ok) throw new Error(`chromeArgs refused ${args.refused} (${args.reason})`);
  if (options.seedFirstRun === true) {
    await mkdir(join(chrome.userDataDir, "Default"), { recursive: true, mode: 0o700 });
    await writeFile(join(chrome.userDataDir, "Default", "Preferences"), JSON.stringify(FIRST_RUN_PREFS), { mode: 0o600 });
  }
  await options.beforeLaunch?.(chrome.userDataDir);
  const binaryVersion = (await run(chrome.app, ["--version"], { env: chromeEnv(home), signal: AbortSignal.timeout(20_000) })).stdout.trim();

  const started = Date.now();
  const proc = await launch(options.name, chrome.app, [...args.args, ...(options.urls ?? [])], home);
  const version = await waitFor(
    async () => {
      if (proc.exited()) throw new Error(`Chrome exited before answering (see chrome-${options.name}.log)`);
      return browserVersion(options.port);
    },
    { label: `/json/version on port ${options.port}`, timeoutMs: 20_000, intervalMs: 100 },
  );
  const readyMs = Date.now() - started;
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  return {
    pid: proc.pid,
    userDataDir: chrome.userDataDir,
    cdp,
    readyMs,
    binaryVersion,
    async close() {
      // Chrome may close the socket before it answers Browser.close; the exit is what counts.
      await cdp.send("Browser.close").catch((err: unknown) => err);
      const exit = await exitWithin(proc.exit, 10_000, "Chrome after Browser.close");
      cdp.close();
      return exit;
    },
  };
}

/** Runs xdotool on the container's display. */
async function xdotool(...args: string[]): Promise<string> {
  const env = { PATH: "/usr/bin:/bin", DISPLAY: process.env.DISPLAY ?? ":99" };
  return (await run("xdotool", args, { env, signal: AbortSignal.timeout(10_000) })).stdout.trim();
}

/**
 * Starts the same Chrome without Desk's flags (no debugging port, no session flags), in a fresh profile with the same
 * window and the first-run prompts off, as the research's baseline did. It has no CDP, so it quits the way a person
 * would: Ctrl+Shift+W through the X server closes its only window, and Chrome exits normally (never a signal).
 */
export async function startBaselineChrome(options: { name: string; urls: readonly string[] }): Promise<{ pid: number; closeWindow(): Promise<Exit> }> {
  assertGuiAllowed();
  const home = await mkdtemp(join(tmpdir(), `${options.name}-home-`));
  const args = [`--user-data-dir=${join(home, "profile")}`, "--no-first-run", "--no-default-browser-check", ...WINDOW, ...options.urls];
  const proc = await launch(options.name, "/usr/bin/google-chrome-stable", args, home);
  return {
    pid: proc.pid,
    async closeWindow() {
      const [window] = (await xdotool("search", "--sync", "--onlyvisible", "--pid", String(proc.pid))).split("\n");
      if (window === undefined || window === "") throw new Error("the baseline Chrome has no visible window");
      await xdotool("windowfocus", "--sync", window);
      await xdotool("key", "--clearmodifiers", "ctrl+shift+w");
      return exitWithin(proc.exit, 10_000, "the baseline Chrome after Ctrl+Shift+W");
    },
  };
}

/** The verdict line of chrome://sandbox, read in a background tab that is closed again. */
export async function sandboxVerdict(cdp: Cdp): Promise<string> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "chrome://sandbox", background: true });
  try {
    const session = await attach(cdp, targetId);
    const text = await waitFor(
      async () => {
        const body = await evaluate<string>(cdp, session, "document.body ? document.body.innerText : ''");
        return /adequately sandboxed/i.test(body) ? body : null;
      },
      { label: "chrome://sandbox" },
    );
    return text.split("\n").find((line) => /adequately sandboxed/i.test(line))?.trim() ?? "";
  } finally {
    await cdp.send("Target.closeTarget", { targetId });
  }
}

/** The machine the installed Chrome binary is built for, from its ELF header (e_machine). */
export async function chromeBinaryMachine(): Promise<string> {
  const file = await open(CHROME_ELF, "r");
  try {
    const header = Buffer.alloc(20);
    await file.read(header, 0, 20, 0);
    const machine = header.readUInt16LE(18);
    return machine === 0xb7 ? "aarch64" : machine === 0x3e ? "x86_64" : `e_machine 0x${machine.toString(16)}`;
  } finally {
    await file.close();
  }
}
