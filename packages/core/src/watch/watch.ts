import { chromeArgs, chromeDefaultDirs } from "../chrome/args.ts";
import type { DeskConfig } from "../config/schema.ts";
import { pollUntil } from "../launch/poll.ts";
import type { BrowserConnector, BrowserSession } from "../ports/browser-connector.ts";
import type { ChromeProcess } from "../ports/chrome-process.ts";
import type { ChromeProfile } from "../ports/chrome-profile.ts";
import type { Clock } from "../ports/clock.ts";
import type { DaemonClient, DaemonNotice } from "../ports/daemon-client.ts";
import type { DevToolsHttp } from "../ports/dev-tools-http.ts";
import type { ExtensionBridge } from "../ports/extension-bridge.ts";
import type { GuardedEndpoint } from "../ports/guarded-endpoint.ts";
import type { InstanceLock } from "../ports/instance-lock.ts";
import type { LogSink } from "../ports/log-sink.ts";
import type { ProcessInfo } from "../ports/process-info.ts";
import type { FollowedBrowser, TargetWatch, TargetWatchEvent } from "../ports/target-watch.ts";
import type { TextFiles } from "../ports/text-files.ts";
import { Backoff } from "../time/backoff.ts";

export type WatchPorts = {
  lock: InstanceLock;
  endpoint: GuardedEndpoint;
  clock: Clock;
  devTools: DevToolsHttp;
  targets: TargetWatch;
  browser: BrowserConnector;
  bridge: ExtensionBridge;
  daemon: DaemonClient;
  chrome: ChromeProcess;
  profile: ChromeProfile;
  processes: ProcessInfo;
  files: TextFiles;
  log: LogSink;
};

export type WatchInput = { config: DeskConfig; deskHome: string; home: string; platform: string; extensionId: string };

/** §6.4's timings. */
const RELAUNCH_AFTER_MS = 2_000;
const RELAUNCH_WINDOW_MS = 10 * 60_000;
const RELAUNCHES_MAX = 2;
const IDLE_CHECK_MS = 60_000;
/** A panel closed this soon before Chrome's socket dropped was open when Chrome went away (Chrome closes it first). */
const PANEL_GRACE_MS = 2_000;
/** How long a reopen waits for a `desk` that holds `run/launch.lock`, and for the service worker. */
const LAUNCH_LOCK_MS = 20_000;
const WORKER_MS = 10_000;
const POLL_MS = 100;
/** Panels say hello about a second after their target appears; the daemon then knows their windows. */
const PANEL_SETTLE_MS = 1_000;
/** How long a crashed panel's host connection gets to leave the daemon's list. */
const CRASH_SETTLE_MS = 5_000;
/** How long an automatically opened panel gets to say hello before the watch gives the keyboard back once more. */
const PANEL_HELLO_MS = 5_000;

/** The browser id at the end of `/json/version`'s WebSocket URL. */
function browserIdOf(wsUrl: string): string {
  return wsUrl.slice(wsUrl.lastIndexOf("/") + 1);
}

/** The Desk panels Chrome has now, and when the last one closed. */
class PanelPresence {
  private open = 0;
  private closedAt = Number.NEGATIVE_INFINITY;

  set(open: number, now: number): void {
    if (this.open > 0 && open === 0) this.closedAt = now;
    this.open = open;
  }

  openNear(now: number): boolean {
    return this.open > 0 || now - this.closedAt <= PANEL_GRACE_MS;
  }

  /** For the log: the panels open now, and how long ago the last one closed. */
  report(now: number): { panels: number; panelClosedMs: number | null } {
    return { panels: this.open, panelClosedMs: Number.isFinite(this.closedAt) ? now - this.closedAt : null };
  }
}

/**
 * `desk watch` (docs/IMPLEMENTATION.md §6.4). One instance, under `run/watch.lock` (whose record names its build), serves
 * the guarded endpoint until `until` settles (SIGTERM, SIGHUP), then closes the endpoint and releases the lock. A second
 * watch exits 0 at once; a taken guarded port exits 75. Meanwhile it follows the Desk Chrome (`ChromeWatch`).
 */
export async function runWatch(ports: WatchPorts, input: WatchInput, until: Promise<void>): Promise<0 | 75> {
  const lock = await ports.lock.acquire("watch");
  if (!lock.ok) return 0;
  try {
    const listening = await ports.endpoint.listen();
    if (!listening.ok) return 75;
    const watch = new ChromeWatch(ports, input);
    watch.start();
    await until;
    watch.stop();
    await ports.endpoint.close();
    return 0;
  } finally {
    await lock.release();
  }
}

/**
 * What `desk watch` does about the Desk Chrome (§6.4). It holds one browser WebSocket through `TargetWatch`; when that
 * closes it probes `/json/version` with backoff from 100 ms to 5 s. Chrome back with a new browser id runs reuse steps 9,
 * 10 and 12 under `run/launch.lock`, reopening the panel only where one was open, in the last-focused window, and
 * without taking focus. A drop without `run/quit.marker` whose `exit_type` is `Crashed` or missing relaunches Chrome after
 * 2 s, at most twice in 10 minutes. No normal window for `idleQuitMinutes` closes Chrome. A Desk target that turns
 * attached raises the terminal-attached alert, and a crashed panel is reopened in its window.
 */
export class ChromeWatch {
  private readonly ports: WatchPorts;
  private readonly input: WatchInput;
  private stopped = false;
  private followed: FollowedBrowser | null = null;
  /** The browser WebSocket while Chrome is followed. */
  private wsUrl: string | null = null;
  private relaunches: number[] = [];
  /** The windows whose panel the daemon lists, refreshed after the panels change. */
  private panelWindows = new Set<number>();
  private panelEpoch = 0;

  constructor(ports: WatchPorts, input: WatchInput) {
    this.ports = ports;
    this.input = input;
  }

  start(): void {
    void this.follow().catch((err: unknown) => this.warn(err));
    void this.idle().catch((err: unknown) => this.warn(err));
  }

  stop(): void {
    this.stopped = true;
    this.followed?.close();
  }

  private get port(): number {
    return this.input.config.chrome.port;
  }

  private get marker(): string {
    return `${this.input.deskHome}/run/quit.marker`;
  }

  private warn(err: unknown): void {
    this.ports.log.write({ event: "warning", errorClass: err instanceof Error ? err.name : "unknown", code: null });
  }

  private async follow(): Promise<void> {
    const backoff = new Backoff(100, 5_000);
    let browserId: string | null = null;
    let panelWasOpen = false;
    while (!this.stopped) {
      const version = await this.ports.devTools.version(this.port);
      if (this.stopped) return;
      if (version === null) {
        await this.ports.clock.sleep(backoff.next());
        continue;
      }
      const id = browserIdOf(version.wsUrl);
      if (browserId !== null && id !== browserId) await this.returned(version.wsUrl, panelWasOpen);
      const panels = new PanelPresence();
      const followed = await this.ports.targets.follow(version.wsUrl, (event) => this.event(event, panels));
      if (followed === null) {
        await this.ports.clock.sleep(backoff.next());
        continue;
      }
      // Only a Chrome it followed counts: one that went away before the watch could follow it says nothing of its panel.
      if (id !== browserId) this.ports.log.write({ event: "chrome-followed" });
      browserId = id;
      backoff.reset();
      this.followed = followed;
      this.wsUrl = version.wsUrl;
      if (this.stopped) followed.close();
      await followed.closed;
      this.followed = null;
      this.wsUrl = null;
      if (this.stopped) return;
      const now = this.ports.clock.now();
      panelWasOpen = panels.openNear(now);
      this.ports.log.write({ event: "chrome-went-away", ...panels.report(now), exitType: await this.ports.profile.exitType() });
      await this.wentAway();
    }
  }

  private event(event: TargetWatchEvent, panels: PanelPresence): void {
    switch (event.type) {
      case "panels":
        panels.set(event.open, this.ports.clock.now());
        void this.refreshPanelWindows().catch((err: unknown) => this.warn(err));
        return;
      case "desk-attached":
        this.ports.log.write({ event: "terminal-attached" });
        void this.notify({ type: "alert", kind: "terminal-attached" });
        return;
      case "panel-crashed":
        void this.reopenCrashed(new Set(this.panelWindows)).catch((err: unknown) => this.warn(err));
        return;
      default: {
        const never: never = event;
        throw new Error(`unknown target event ${String(never)}`);
      }
    }
  }

  private async notify(notice: DaemonNotice): Promise<void> {
    const opened = await this.ports.daemon.open("watch");
    if (!opened.ok) return;
    try {
      await opened.session.notify(notice);
    } finally {
      opened.session.close();
    }
  }

  /** Chrome's socket closed: `desk quit` and idle quits leave the marker; a crash is relaunched. */
  private async wentAway(): Promise<void> {
    if ((await this.ports.files.read(this.marker)) !== null) {
      await this.ports.files.remove(this.marker);
      return;
    }
    if (!this.input.config.chrome.relaunchAfterCrash) return;
    const exit = await this.ports.profile.exitType();
    if (exit !== null && exit !== "Crashed") return;
    await this.ports.clock.sleep(RELAUNCH_AFTER_MS);
    if (this.stopped || (await this.ports.devTools.version(this.port)) !== null) return;
    const lock = await this.ports.profile.singleton();
    if (lock !== null && (await this.ports.processes.alive(lock.pid))) return;
    const now = this.ports.clock.now();
    this.relaunches = this.relaunches.filter((at) => now - at < RELAUNCH_WINDOW_MS);
    if (this.relaunches.length >= RELAUNCHES_MAX) {
      this.ports.log.write({ event: "relaunch-stopped", within10Minutes: this.relaunches.length });
      return;
    }
    const args = chromeArgs({
      chrome: this.input.config.chrome,
      userDataDirReal: await this.ports.files.realPath(this.input.config.chrome.userDataDir),
      chromeDefaultDirsReal: await Promise.all(chromeDefaultDirs(this.input.home, this.input.platform).map((dir) => this.ports.files.realPath(dir))),
    });
    if (!args.ok) return;
    this.relaunches.push(now);
    await this.ports.chrome.start(args.args);
    this.ports.log.write({ event: "chrome-relaunched", within10Minutes: this.relaunches.length });
  }

  /**
   * Chrome came back with a new browser id (an update relaunch, `chrome://restart`, a crash relaunch, or a `desk`): reuse
   * steps 9, 10 and 12, under `run/launch.lock` so a `desk` that is launching finishes first.
   */
  private async returned(wsUrl: string, panelWasOpen: boolean): Promise<void> {
    const lock = await pollUntil(this.ports.clock, LAUNCH_LOCK_MS, POLL_MS, async () => {
      const attempt = await this.ports.lock.acquire("launch");
      return attempt.ok ? attempt : null;
    });
    if (lock === null) return;
    let session: BrowserSession | null = null;
    try {
      const connected = await this.ports.browser.connect(wsUrl);
      if (!connected.ok) return;
      session = connected.session;
      const extension = await this.ensureExtension(session);
      const worker = (await pollUntil(this.ports.clock, WORKER_MS, POLL_MS, async () => ((await this.workerConnected()) ? true : null))) !== null;
      const panel = panelWasOpen && worker ? await this.reopenPanel(session) : "not-open";
      this.ports.log.write({ event: "chrome-returned", extension, worker, panel });
    } finally {
      session?.close();
      await lock.release();
    }
  }

  /**
   * Step 9: Chrome removes a CDP-loaded extension at every start, so it is loaded again from `~/.desk/extension`; `force`
   * loads it even at the rendered version (its renderer crashed, and its worker with it).
   */
  private async ensureExtension(session: BrowserSession, force = false): Promise<"loaded" | "kept" | "refused"> {
    const dir = `${this.input.deskHome}/extension`;
    const manifest = await this.ports.files.read(`${dir}/manifest.json`);
    let rendered: unknown = null;
    try {
      rendered = manifest === null ? null : (JSON.parse(manifest) as { version?: unknown }).version;
    } catch {
      rendered = null;
    }
    if (!force && typeof rendered === "string" && (await session.extension.installedVersion(this.input.extensionId)) === rendered) return "kept";
    const loaded = await session.extension.load(dir);
    return loaded.ok && loaded.id === this.input.extensionId ? "loaded" : "refused";
  }

  private async workerConnected(): Promise<boolean> {
    const opened = await this.ports.daemon.open("watch");
    if (!opened.ok) return false;
    try {
      const reply = await opened.session.request({ type: "list" });
      return reply?.type === "panes" && reply.sw.connected;
    } finally {
      opened.session.close();
    }
  }

  /** Step 12 for a returned Chrome: only in the last-focused window, only when no window shows the panel, never focused. */
  private async reopenPanel(session: BrowserSession): Promise<"reopened" | "open" | "no-focus-guard"> {
    const windows = await this.ports.bridge.windows();
    if (windows === null || windows.length === 0) return "no-focus-guard";
    if (windows.some((entry) => entry.panelOpen)) return "open";
    const target = windows.find((entry) => entry.lastFocused) ?? windows.find((entry) => entry.focused) ?? windows[0];
    if (target === undefined) return "no-focus-guard";
    const opened = await this.openWithoutFocus(session, target.id, false);
    if (opened !== "opened") this.ports.log.write({ event: "panel-not-reopened", step: opened });
    return opened === "opened" ? "reopened" : "no-focus-guard";
  }

  /**
   * The toolbar action in the window, after the worker made the next panel open without taking the keyboard; never
   * without that. Chrome still hands a side panel the keyboard the first time it shows it in a window, so when that
   * window is the focused one, the tab you were in gets it back: at once, and again once the panel said hello.
   */
  private async openWithoutFocus(
    session: BrowserSession,
    windowId: number,
    close: boolean,
  ): Promise<"opened" | "no-tab" | "no-focus-guard" | "action-refused"> {
    const tab = await session.panels.tabTargetInWindow(windowId);
    if (tab === null) return "no-tab";
    const focused = (await this.ports.bridge.windows())?.find((entry) => entry.id === windowId)?.focused === true;
    const page = focused ? await this.ports.bridge.tabCurrent() : null;
    if (!(await this.ports.bridge.autoOpen(windowId, close))) return "no-focus-guard";
    if (!(await session.panels.open(this.input.extensionId, tab))) return "action-refused";
    if (page !== null) {
      await session.pages.bringToFront(page);
      await pollUntil(this.ports.clock, PANEL_HELLO_MS, POLL_MS, async () => ((await this.listedPanelWindows())?.has(windowId) === true ? true : null));
      await session.pages.bringToFront(page);
    }
    return "opened";
  }

  /** The windows whose panel said hello to the daemon, or `null` when it does not answer. */
  private async listedPanelWindows(): Promise<Set<number> | null> {
    const opened = await this.ports.daemon.open("watch");
    if (!opened.ok) return null;
    try {
      const reply = await opened.session.request({ type: "list" });
      return reply?.type === "panes" ? new Set(reply.panels.map((panel) => panel.window)) : null;
    } finally {
      opened.session.close();
    }
  }

  /** After the panels change and settle, the windows that show one. */
  private async refreshPanelWindows(): Promise<void> {
    this.panelEpoch += 1;
    const epoch = this.panelEpoch;
    await this.ports.clock.sleep(PANEL_SETTLE_MS);
    if (epoch !== this.panelEpoch) return;
    const listed = await this.listedPanelWindows();
    if (listed !== null && epoch === this.panelEpoch) this.panelWindows = listed;
  }

  /**
   * A crashed panel is closed by Chrome, and CDP names no window for a side panel: the window is the one whose panel the
   * daemon listed before the crash (or still lists as it arrives) and no longer lists once the crashed panel's
   * connection is gone. When none can be named, the last-focused window gets the panel if no window shows one. A panel
   * crash takes the extension's renderer, and with it the service worker, which nothing restarts: the extension is
   * loaded again first, so the worker can make the reopened panel `focus=0`.
   */
  private async reopenCrashed(known: ReadonlySet<number>): Promise<void> {
    const before = new Set([...known, ...((await this.listedPanelWindows()) ?? [])]);
    let crashed =
      (await pollUntil(this.ports.clock, CRASH_SETTLE_MS, POLL_MS * 2, async () => {
        const after = await this.listedPanelWindows();
        const lost = after === null ? [] : [...before].filter((windowId) => !after.has(windowId));
        return lost.length > 0 ? lost : null;
      })) ?? [];
    const wsUrl = this.wsUrl;
    if (wsUrl === null) return;
    const connected = await this.ports.browser.connect(wsUrl);
    if (!connected.ok) return;
    try {
      let extension: "loaded" | "kept" | "refused" = "kept";
      let worker = await this.workerConnected();
      if (!worker) {
        extension = await this.ensureExtension(connected.session, true);
        worker = (await pollUntil(this.ports.clock, WORKER_MS, POLL_MS, async () => ((await this.workerConnected()) ? true : null))) !== null;
      }
      this.ports.log.write({ event: "panel-crashed", windows: before.size, lost: crashed.length, extension });
      if (!worker) {
        this.ports.log.write({ event: "panel-not-reopened", step: "no-focus-guard" });
        return;
      }
      if (crashed.length === 0) {
        const windows = await this.ports.bridge.windows();
        const target = windows?.find((entry) => entry.lastFocused) ?? windows?.find((entry) => entry.focused) ?? windows?.[0];
        if (windows === null || windows.some((entry) => entry.panelOpen) || target === undefined) return;
        crashed = [target.id];
      }
      for (const windowId of crashed) {
        const opened = await this.openWithoutFocus(connected.session, windowId, true);
        this.ports.log.write(opened === "opened" ? { event: "panel-reopened", reason: "crashed" } : { event: "panel-not-reopened", step: opened });
      }
    } finally {
      connected.session.close();
    }
  }

  /** Every 60 s: no normal window for `idleQuitMinutes` closes Chrome; a check the worker does not answer is unknown. */
  private async idle(): Promise<void> {
    const minutes = this.input.config.chrome.idleQuitMinutes;
    if (minutes === 0) return;
    let since: number | null = null;
    while (!this.stopped) {
      await this.ports.clock.sleep(IDLE_CHECK_MS);
      const wsUrl = this.wsUrl;
      if (this.stopped) return;
      if (wsUrl === null) {
        since = null;
        continue;
      }
      const windows = await this.ports.bridge.windows();
      if (windows === null || windows.length > 0) {
        since = null;
        continue;
      }
      const now = this.ports.clock.now();
      since ??= now;
      if (now - since < minutes * 60_000) continue;
      since = null;
      await this.ports.files.write(this.marker, `${now}\n`, 0o600);
      const connected = await this.ports.browser.connect(wsUrl);
      if (!connected.ok) continue;
      try {
        await connected.session.lifecycle.close();
        this.ports.log.write({ event: "idle-quit", minutes });
      } finally {
        connected.session.close();
      }
    }
  }
}
