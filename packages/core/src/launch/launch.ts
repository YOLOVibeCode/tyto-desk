import { chromeArgs, chromeDefaultDirs } from "../chrome/args.ts";
import { loadOrCreateConfig } from "../config/load.ts";
import type { DeskConfig } from "../config/schema.ts";
import type { BrowserConnector, BrowserSession } from "../ports/browser-connector.ts";
import type { ChromeProcess } from "../ports/chrome-process.ts";
import type { ChromeProfile } from "../ports/chrome-profile.ts";
import type { Clock } from "../ports/clock.ts";
import type { ConfigStore } from "../ports/config-store.ts";
import type { DaemonClient } from "../ports/daemon-client.ts";
import type { DevToolsHttp } from "../ports/dev-tools-http.ts";
import type { ExtensionBridge } from "../ports/extension-bridge.ts";
import type { InstanceLock } from "../ports/instance-lock.ts";
import type { NativeHostDir } from "../ports/native-host-dir.ts";
import type { PortProbe } from "../ports/port-probe.ts";
import type { ProcessInfo } from "../ports/process-info.ts";
import type { Random } from "../ports/random.ts";
import type { TextFiles } from "../ports/text-files.ts";
import { prepareFiles } from "./files.ts";
import { ensurePanel } from "./panel.ts";
import { pollUntil } from "./poll.ts";

/** The Desk Chrome's process, profile and host directory, which the config (loaded under the lock) names. */
export type ChromePorts = { chrome: ChromeProcess; profile: ChromeProfile; hosts: NativeHostDir };

export type LaunchPorts = {
  lock: InstanceLock;
  config: ConfigStore;
  probe: PortProbe;
  random: Random;
  clock: Clock;
  chromeFor(config: DeskConfig): ChromePorts;
  processes: ProcessInfo;
  devTools: DevToolsHttp;
  browser: BrowserConnector;
  daemon: DaemonClient;
  bridge: ExtensionBridge;
  files: TextFiles;
};

export type LaunchInput = {
  home: string;
  /** `~/.desk`, or the DESK_HOME the launcher names. */
  deskHome: string;
  platform: string;
  /** The current version, resolved once by the launcher: its version.json `version` and its directory under app/. */
  version: string;
  appDir: string;
};

/** §6.5: 65 bad config · 69 Chrome missing · 70 internal · 73 cannot write ~/.desk · 75 temporarily unavailable. */
export type LaunchFailure = { ok: false; code: 65 | 69 | 70 | 73 | 75; message: string };
export type LaunchResult = { ok: true; message: string } | LaunchFailure;

/** The first-run seed (§5): the panel on the left, 640 px wide; both prefs are unprotected and not syncable. */
export const FIRST_RUN_PREFS = { side_panel: { is_right_aligned: false, id_to_width: { kExtension: 640 } } } as const;

/** §6.6's budgets. */
const LAUNCH_LOCK_MS = 10_000;
const JSON_VERSION_MS = 20_000;
const POLL_MS = 100;
const WORKER_MS = 5_000;

function fail(code: LaunchFailure["code"], message: string): LaunchFailure {
  return { ok: false, code, message };
}

/** The major version of `155.0.8059.40`, or null. */
function major(version: string): number | null {
  const match = /^(\d+)\./.exec(version);
  return match === null ? null : Number(match[1]);
}

/**
 * `desk` on a fresh launch (docs/IMPLEMENTATION.md §6.1 steps 1–3, 5–10, 12 and 14; slice 1c). It holds
 * `run/launch.lock`, loads or creates the config, checks Chrome's version, and launches only when no Desk Chrome is
 * running (a live singleton, or anything answering on the Desk port, exits 75: reuse is slice 3b). Then it writes the
 * launch files, seeds the first run, starts Chrome with `chromeArgs`, waits for `/json/version`, loads the extension
 * unless Chrome already has the rendered version, waits for the service worker to reach the daemon (waking it with the
 * toolbar action after 5 s), and opens the panel in the last-focused window, waiting for that panel's hello.
 */
export async function launch(ports: LaunchPorts, input: LaunchInput): Promise<LaunchResult> {
  const startedAt = ports.clock.now();
  const lock = await pollUntil(ports.clock, LAUNCH_LOCK_MS, POLL_MS, async () => {
    const attempt = await ports.lock.acquire("launch");
    return attempt.ok ? attempt : null;
  });
  if (lock === null) {
    return fail(75, "another desk is starting the Desk Chrome; run desk again once it is ready");
  }
  let session: BrowserSession | null = null;
  try {
    const loaded = await loadOrCreateConfig({
      store: ports.config,
      probe: ports.probe,
      random: ports.random,
      home: input.home,
      platform: input.platform,
    });
    if (!loaded.ok) {
      if (loaded.code === "no-free-ports") return fail(75, "no two ports from 9400 to 9899 are free for the Desk Chrome");
      return fail(65, `Desk cannot make a config here (${loaded.code})`);
    }
    const config = loaded.config;
    const { chrome: installed, profile, hosts } = ports.chromeFor(config);
    const chromeVersion = await installed.version();
    const chromeMajor = chromeVersion === null ? null : major(chromeVersion);
    if (chromeVersion === null || chromeMajor === null) return fail(69, `Google Chrome is not installed at ${config.chrome.app}`);
    if (chromeMajor < config.chrome.minMajor) {
      return fail(69, `Google Chrome ${chromeVersion} is older than ${config.chrome.minMajor}; update Chrome and run desk again`);
    }

    const running = await deskChromeRunning(ports, profile, config);
    if (running !== null) return running;

    const prepared = await prepareFiles({
      files: ports.files,
      hosts,
      config,
      deskHome: input.deskHome,
      appDir: input.appDir,
      version: input.version,
      platform: input.platform,
    });
    if (!prepared.ok) return fail(70, `the installed version's extension is damaged (${input.appDir}); run desk install`);

    await profile.seedFirstRun(FIRST_RUN_PREFS);
    const args = chromeArgs({
      chrome: config.chrome,
      userDataDirReal: await ports.files.realPath(config.chrome.userDataDir),
      chromeDefaultDirsReal: await Promise.all(chromeDefaultDirs(input.home, input.platform).map((dir) => ports.files.realPath(dir))),
    });
    if (!args.ok) return fail(65, `config.json's Chrome settings are refused (${args.reason}: ${args.refused})`);
    const started = await installed.start(args.args);
    if (!started.ok) {
      return fail(70, started.reason === "gui-refused" ? "Desk may not open windows here (DESK_NO_GUI, or not the desk launcher)" : "Chrome did not start");
    }

    const version = await pollUntil(ports.clock, JSON_VERSION_MS, POLL_MS, () => ports.devTools.version(config.chrome.port));
    if (version === null) return fail(70, `Chrome did not answer on port ${config.chrome.port} within 20 s`);
    const connected = await ports.browser.connect(version.wsUrl);
    if (!connected.ok) return fail(70, `Chrome answered on port ${config.chrome.port} but its browser WebSocket did not`);
    session = connected.session;

    const expectedId = prepared.extensionId;
    if ((await session.extension.installedVersion(expectedId)) !== prepared.manifestVersion) {
      const load = await session.extension.load(prepared.extensionDir);
      if (!load.ok) {
        return fail(
          70,
          `Chrome refused to load the Desk extension over its debugging port. Load it once by hand: chrome://extensions, ` +
            `turn on Developer mode, Load unpacked, and pick ${prepared.extensionDir}`,
        );
      }
      if (load.id !== expectedId) {
        return fail(70, `Chrome loaded the Desk extension as ${load.id}, not as ${expectedId}, the id its key gives`);
      }
    }

    if (!(await workerReady(ports, session, expectedId))) {
      return fail(70, "the Desk extension's service worker did not reach the terminal daemon; run desk doctor");
    }

    const panel = await ensurePanel({ bridge: ports.bridge, panels: session.panels, daemon: ports.daemon, clock: ports.clock, extensionId: expectedId });
    if (!panel.ok) return fail(70, panel.message);

    const seconds = ((ports.clock.now() - startedAt) / 1000).toFixed(1);
    const ready = `Desk ready (port ${config.chrome.port}, guarded ${config.gateway.port}, Chrome ${chromeVersion}) in ${seconds} s`;
    return { ok: true, message: panel.createdWindow ? `${ready}. Cmd+Shift+T reopens the window you closed` : ready };
  } finally {
    session?.close();
    await lock.release();
  }
}

/**
 * Slice 1c's classification: a live Desk singleton, or anything already answering on the Desk port, means a Chrome
 * Desk did not start now; reusing it (or moving to a free port) is slice 3b, so this launch stops without starting one.
 */
async function deskChromeRunning(ports: LaunchPorts, profile: ChromeProfile, config: DeskConfig): Promise<LaunchFailure | null> {
  const singleton = await profile.singleton();
  if (singleton !== null && (await ports.processes.alive(singleton.pid))) {
    return fail(75, `the Desk Chrome is already running (pid ${singleton.pid}); quit it with Cmd+Q, then run desk`);
  }
  if ((await ports.devTools.version(config.chrome.port)) !== null) {
    return fail(75, `port ${config.chrome.port} is held by another program; quit it, then run desk`);
  }
  return null;
}

/** Whether the daemon reports a connected service worker. */
async function swConnected(daemon: DaemonClient): Promise<boolean> {
  const opened = await daemon.open("cli");
  if (!opened.ok) return false;
  try {
    const reply = await opened.session.request({ type: "list" });
    return reply?.type === "panes" && reply.sw.connected;
  } finally {
    opened.session.close();
  }
}

/**
 * Step 10: the worker opens its own native connection at start, which starts the daemon. Wait 5 s for its hello to
 * reach the daemon; if it has not, the toolbar action on any tab wakes the worker, and it gets 5 s more.
 */
async function workerReady(ports: LaunchPorts, session: BrowserSession, extensionId: string): Promise<boolean> {
  const waitForWorker = () => pollUntil(ports.clock, WORKER_MS, POLL_MS, async () => ((await swConnected(ports.daemon)) ? true : null));
  if ((await waitForWorker()) !== null) return true;
  const tab = await session.panels.anyTabTarget();
  if (tab !== null) await session.panels.open(extensionId, tab);
  return (await waitForWorker()) !== null;
}
