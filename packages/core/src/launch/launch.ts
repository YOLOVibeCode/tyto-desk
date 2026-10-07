import { chromeArgs, chromeDefaultDirs } from "../chrome/args.ts";
import { allocateDeskPort } from "../config/allocate.ts";
import { loadOrCreateConfig } from "../config/load.ts";
import type { DeskConfig } from "../config/schema.ts";
import type { BrowserConnector, BrowserSession } from "../ports/browser-connector.ts";
import type { ChromeProcess } from "../ports/chrome-process.ts";
import type { ChromeProfile } from "../ports/chrome-profile.ts";
import type { Clock } from "../ports/clock.ts";
import type { ConfigStore } from "../ports/config-store.ts";
import type { DaemonClient } from "../ports/daemon-client.ts";
import type { DetachedSpawner } from "../ports/detached-spawner.ts";
import type { DevToolsHttp } from "../ports/dev-tools-http.ts";
import type { ExtensionBridge } from "../ports/extension-bridge.ts";
import type { InstanceLock } from "../ports/instance-lock.ts";
import type { ListenerInfo } from "../ports/listener-info.ts";
import type { NativeHostDir } from "../ports/native-host-dir.ts";
import type { PortProbe } from "../ports/port-probe.ts";
import type { ProcessInfo } from "../ports/process-info.ts";
import type { ProcessSignals } from "../ports/process-signals.ts";
import type { Random } from "../ports/random.ts";
import type { TextFiles } from "../ports/text-files.ts";
import type { DaemonCommand } from "../nmhost/host.ts";
import { classifyLaunch, listenerIsDesk, singletonState, staleLockToClear, type LaunchDecision } from "./classify.ts";
import { prepareFiles } from "./files.ts";
import { ensurePanel } from "./panel.ts";
import { pollUntil } from "./poll.ts";
import { applyChromeSettings } from "./settings.ts";
import { ensureWatch } from "./watch-start.ts";

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
  listeners: ListenerInfo;
  devTools: DevToolsHttp;
  browser: BrowserConnector;
  daemon: DaemonClient;
  bridge: ExtensionBridge;
  files: TextFiles;
  spawner: DetachedSpawner;
  signals: ProcessSignals;
};

export type LaunchInput = {
  home: string;
  /** `~/.desk`, or the DESK_HOME the launcher names. */
  deskHome: string;
  platform: string;
  /** This machine's host name, as Chrome writes it into SingletonLock. */
  host: string;
  /** The current version, resolved once by the launcher: its version.json `version` and its directory under app/. */
  version: string;
  appDir: string;
  /** The current version's `desk watch`: its Desk Terminal, `desk.mjs watch`, and the environment it starts with. */
  watchCommand: DaemonCommand;
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
/** §6.1 step 4: how long a Desk Chrome whose port is silent (it is quitting) gets to exit. */
const QUITTING_MS = 10_000;

/** What the launch says when `desk watch` did not start (§6.1 step 13). */
export const WATCH_WARNING =
  "desk watch did not start, so agents cannot reach the guarded endpoint until the next desk; desk cdp --raw still works";

function fail(code: LaunchFailure["code"], message: string): LaunchFailure {
  return { ok: false, code, message };
}

/** The major version of `155.0.8059.40`, or null. */
function major(version: string): number | null {
  const match = /^(\d+)\./.exec(version);
  return match === null ? null : Number(match[1]);
}

/**
 * `desk` (docs/IMPLEMENTATION.md §6.1, §6.2; slices 1c, 3a, 3b and 4a). It holds `run/launch.lock`, loads or creates
 * the config, checks Chrome's version, and classifies the Desk Chrome it finds (step 4): it reuses a running one whose
 * listener it can verify, waits for one that is quitting, moves Chrome to a new raw port when another program holds the
 * port, and fails closed on anything it cannot verify. Then it writes the launch files, and on a launch seeds the first
 * run, starts Chrome with `chromeArgs` and waits for `/json/version`. Both paths load the extension unless Chrome
 * already has the rendered version, wait for the service worker to reach the daemon (waking it with the toolbar action
 * after 5 s), and show the panel: focusing a window that shows it, else opening it in the last-focused window and
 * waiting for that panel's hello. A launch also applies Chrome's settings (background mode off on the first run; §5).
 * Then it makes sure the current version's `desk watch` serves the guarded endpoint, replacing one of another version,
 * or any after a port move, without touching the daemon.
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
    let config = loaded.config;
    const { chrome: installed, profile, hosts } = ports.chromeFor(config);
    const chromeVersion = await installed.version();
    const chromeMajor = chromeVersion === null ? null : major(chromeVersion);
    if (chromeVersion === null || chromeMajor === null) return fail(69, `Google Chrome is not installed at ${config.chrome.app}`);
    if (chromeMajor < config.chrome.minMajor) {
      return fail(69, `Google Chrome ${chromeVersion} is older than ${config.chrome.minMajor}; update Chrome and run desk again`);
    }

    const appRoot = input.platform === "darwin" ? config.chrome.app : parentDir(await ports.files.realPath(config.chrome.app));
    let found = await findDeskChrome(ports, profile, config, input.host, appRoot);
    if (found.decision === "wait") {
      const quit = await pollUntil(ports.clock, QUITTING_MS, POLL_MS, async () => ((await deskSingletonAlive(ports, profile, config)) ? null : true));
      if (quit !== null) found = await findDeskChrome(ports, profile, config, input.host, appRoot);
      if (found.decision === "wait") return fail(75, "the Desk Chrome is running without its debugging port; quit it with Cmd+Q");
    }
    if (found.decision === "foreign") {
      return fail(75, `port ${config.chrome.port} is held by another program while the Desk Chrome runs; quit the Desk Chrome (Cmd+Q) and run desk`);
    }
    let moved: string | null = null;
    if (found.decision === "move-port") {
      const port = await allocateDeskPort(ports.probe, ports.random, [config.chrome.port, config.gateway.port]);
      if (port === null) return fail(75, `port ${config.chrome.port} is in use and no other port from 9400 to 9899 is free for the Desk Chrome`);
      moved = `port ${config.chrome.port} was in use, so the Desk Chrome now uses port ${port}; agents keep the guarded port ${config.gateway.port}`;
      config = { ...config, chrome: { ...config.chrome, port } };
      await ports.config.save(config);
    }

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

    let wsUrl: string;
    let firstRun = false;
    if (found.decision === "reuse") {
      wsUrl = found.wsUrl;
    } else {
      if (found.clearStale) await profile.clearStaleSingleton();
      firstRun = await profile.seedFirstRun(FIRST_RUN_PREFS);
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
      wsUrl = version.wsUrl;
    }
    const connected = await ports.browser.connect(wsUrl);
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

    const settingsWarning =
      found.decision === "reuse" ? null : await applyChromeSettings(session.settings, { firstRun, setContinuePref: config.chrome.setContinuePref });

    const panel = await ensurePanel({ bridge: ports.bridge, panels: session.panels, daemon: ports.daemon, clock: ports.clock, extensionId: expectedId });
    if (!panel.ok) return fail(70, panel.message);

    const seconds = ((ports.clock.now() - startedAt) / 1000).toFixed(1);
    const ready = `Desk ready (port ${config.chrome.port}, guarded ${config.gateway.port}, Chrome ${chromeVersion}) in ${seconds} s`;
    const watching = await ensureWatch(ports, { command: input.watchCommand, version: input.version, replace: moved !== null });
    const notes = [moved, panel.createdWindow ? "Cmd+Shift+T reopens the window you closed" : null, settingsWarning, watching ? null : WATCH_WARNING];
    return { ok: true, message: [ready, ...notes.filter((note): note is string => note !== null)].join(". ") };
  } finally {
    session?.close();
    await lock.release();
  }
}

type Found = { decision: Exclude<LaunchDecision, "reuse">; clearStale: boolean } | { decision: "reuse"; wsUrl: string };

/** The parent directory of an absolute path (`/opt/google/chrome` for `/opt/google/chrome/google-chrome`). */
function parentDir(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

/** The pids that use the Desk profile, from their `--user-data-dir` argument; `null` when unknown. */
function profileUsers(ports: LaunchPorts, config: DeskConfig): Promise<number[] | null> {
  return ports.processes.withArgument(`--user-data-dir=${config.chrome.userDataDir}`);
}

/** Whether the profile's SingletonLock names a live process that uses the Desk profile. */
async function deskSingletonAlive(ports: LaunchPorts, profile: ChromeProfile, config: DeskConfig): Promise<boolean> {
  const lock = await profile.singleton();
  if (lock === null) return false;
  const alive = await ports.processes.alive(lock.pid);
  return singletonState({ lock, alive, users: alive ? await profileUsers(ports, config) : [] }) === "alive";
}

/**
 * §6.1 step 4: the facts `classifyLaunch` decides from. The listener is looked up only for a live singleton whose port
 * answers, and the port is probed only when no live singleton holds the profile.
 */
async function findDeskChrome(ports: LaunchPorts, profile: ChromeProfile, config: DeskConfig, host: string, appRoot: string): Promise<Found> {
  const lock = await profile.singleton();
  const alive = lock !== null && (await ports.processes.alive(lock.pid));
  const users = lock === null ? [] : await profileUsers(ports, config);
  const state = singletonState({ lock, alive, users });
  const version = await ports.devTools.version(config.chrome.port);
  let listener: "desk" | "other" | "unverifiable" = "unverifiable";
  if (state === "alive" && version !== null && lock !== null) {
    const listenerPid = await ports.listeners.listenerPid(config.chrome.port);
    const image = listenerPid === null ? null : await ports.listeners.image(listenerPid);
    listener = listenerIsDesk({ singletonPid: lock.pid, listenerPid, image, appRoot, userDataDir: config.chrome.userDataDir });
  }
  const busy = state === "alive" ? version !== null : version !== null || !(await ports.probe.isFree(config.chrome.port));
  const decision = classifyLaunch({ singleton: state, answers: version !== null, busy, listener });
  if (decision === "reuse" && version !== null) return { decision, wsUrl: version.wsUrl };
  return { decision: decision === "reuse" ? "foreign" : decision, clearStale: staleLockToClear({ lock, host, state, users }) };
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
