import { describe, expect, it } from "vitest";
import { DESK_EXTENSION_ID, newDeskConfig, runWatch, type DeskConfig, type DeskWindow, type WatchPorts } from "../src/index.ts";
import {
  FakeBrowserConnector,
  FakeChromeProcess,
  FakeChromeProfile,
  FakeClock,
  FakeDaemonClient,
  FakeDeskExtension,
  FakeDevToolsHttp,
  FakeExtensionBridge,
  FakeGuardedEndpoint,
  FakeInstanceLock,
  FakePanelOpener,
  FakeProcessInfo,
  FakeTargetWatch,
  MemoryLogSink,
  MemoryTextFiles,
} from "../src/testing/index.ts";

const home = "/Users/alex";
const deskHome = "/Users/alex/.desk";
const config = newDeskConfig({ home, platform: "darwin", chromePort: 9417, gatewayPort: 9583 });
const MARKER = `${deskHome}/run/quit.marker`;
const win = (id: number, change: Partial<DeskWindow> = {}): DeskWindow => ({ id, focused: false, lastFocused: false, panelOpen: false, ...change });

/** A stop signal the test fires, as SIGTERM or SIGHUP does for the process. */
function stopper() {
  let stop: () => void = () => undefined;
  const until = new Promise<void>((resolve) => {
    stop = resolve;
  });
  return { until, stop };
}

/** Lets pending promises run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

/** Moves virtual time forward in 100 ms steps, letting each step's promises run (a poll's probe awaits the daemon). */
async function pass(clock: FakeClock, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 100) {
    await clock.advance(Math.min(100, left));
    await settle();
  }
}

/** A running Desk Chrome with the panel open in window 1, and a watch following it. */
function setup(options: { config?: DeskConfig } = {}) {
  const log: string[] = [];
  const clock = new FakeClock();
  const devTools = new FakeDevToolsHttp({ answering: true });
  const targets = new FakeTargetWatch();
  const extension = new FakeDeskExtension({ loadAs: DESK_EXTENSION_ID, log });
  extension.loadVersion = "0.3.1.1";
  extension.installed.set(DESK_EXTENSION_ID, "0.3.1.1");
  const panels = new FakePanelOpener(log);
  panels.tabs.set(1, "tab-1");
  panels.tabs.set(2, "tab-2");
  const browser = new FakeBrowserConnector(extension, panels, log);
  // A panel the toolbar action opens says hello from its window.
  panels.onOpen = (tab) => {
    const id = Number(tab.split("-")[1]);
    if (!daemon.panels.includes(id)) daemon.panels.push(id);
  };
  // Window 1 shows the panel, connected to the daemon; window 2 has none.
  const bridge = new FakeExtensionBridge([win(1, { lastFocused: true, focused: true, panelOpen: true }), win(2)]);
  const daemon = new FakeDaemonClient({ log });
  daemon.swConnected = true;
  daemon.panels = [1];
  const chrome = new FakeChromeProcess("155.0.8059.40", log);
  const profile = new FakeChromeProfile();
  const processes = new FakeProcessInfo();
  const files = new MemoryTextFiles({ [`${deskHome}/extension/manifest.json`]: JSON.stringify({ version: "0.3.1.1" }) });
  const sink = new MemoryLogSink();
  const lock = new FakeInstanceLock();
  const endpoint = new FakeGuardedEndpoint(log);
  const ports: WatchPorts = { lock, endpoint, clock, devTools, targets, browser, bridge, daemon, chrome, profile, processes, files, log: sink };
  const { until, stop } = stopper();
  const running = runWatch(ports, { config: options.config ?? config, deskHome, home, platform: "darwin", extensionId: DESK_EXTENSION_ID }, until);

  /** Chrome restarts by itself (chrome://restart, an update): the socket drops and a new browser answers. */
  const restart = async (id: string) => {
    devTools.answering = false;
    targets.drop();
    await settle();
    devTools.browserId = id;
    devTools.answering = true;
    await clock.advance(200);
    await settle();
  };
  return { log, clock, devTools, targets, extension, panels, browser, bridge, daemon, chrome, profile, processes, files, sink, lock, endpoint, running, stop, restart };
}

describe("desk watch's lock and endpoint (docs/IMPLEMENTATION.md §6.4)", () => {
  it("desk watch exits 0 on SIGTERM after closing the guarded endpoint and releasing its lock", async () => {
    const watch = setup();
    await watch.endpoint.listening;
    await settle();
    watch.log.push("SIGTERM");
    watch.stop();

    expect(await watch.running).toBe(0);
    expect(watch.log.slice(0, 1)).toEqual(["endpoint.listen"]);
    expect(watch.log.slice(-2)).toEqual(["SIGTERM", "endpoint.close"]);
    expect(watch.lock.acquired).toEqual(["watch"]);
    expect(watch.lock.released).toEqual(["watch"]);
  });

  it("a second desk watch exits 0 at once while a live watch holds the lock, and serves nothing", async () => {
    const lock = new FakeInstanceLock();
    lock.heldBy.set("watch", 5151);
    const endpoint = new FakeGuardedEndpoint();
    const ports = { lock, endpoint } as unknown as WatchPorts;

    expect(await runWatch(ports, { config, deskHome, home, platform: "darwin", extensionId: DESK_EXTENSION_ID }, new Promise(() => undefined))).toBe(0);
    expect(endpoint.listens).toBe(0);
  });

  it("desk watch exits 75 and releases its lock when the guarded port is taken", async () => {
    const lock = new FakeInstanceLock();
    const endpoint = new FakeGuardedEndpoint();
    endpoint.portTaken = true;
    const ports = { lock, endpoint } as unknown as WatchPorts;

    expect(await runWatch(ports, { config, deskHome, home, platform: "darwin", extensionId: DESK_EXTENSION_ID }, new Promise(() => undefined))).toBe(75);
    expect(lock.released).toEqual(["watch"]);
  });
});

describe("desk watch follows the Desk Chrome (slice 3b, §6.4)", () => {
  it("a Chrome that went away before the watch could follow it is not taken for one that came back", async () => {
    const watch = setup();
    watch.targets.refuse = true;
    await settle();
    watch.devTools.browserId = "b-2";
    watch.targets.refuse = false;
    await watch.clock.advance(200);
    await settle();

    expect(watch.extension.loads).toEqual([]);
    expect(watch.sink.events.filter((e) => e.event === "chrome-returned")).toEqual([]);
    expect(watch.sink.events).toContainEqual({ event: "chrome-followed" });
  });

  it("desk watch holds one browser WebSocket to the Desk Chrome", async () => {
    const watch = setup();
    await settle();

    expect(watch.targets.followed).toEqual(["ws://127.0.0.1:9417/devtools/browser/0b5ad5d6-0000-4000-8000-000000000001"]);
    expect(watch.targets.following).toBe(true);
  });

  it("desk watch reopens the extension and the panel when Chrome returns with a new browser id", async () => {
    const watch = setup();
    await settle();
    watch.targets.emit({ type: "panels", open: 1 });
    watch.extension.installed.clear();
    watch.bridge.windowList = [win(1, { lastFocused: true })];

    await watch.restart("b-2");

    expect(watch.extension.loads).toEqual([`${deskHome}/extension`]);
    expect(watch.bridge.autoOpens).toEqual([{ windowId: 1, close: false }]);
    expect(watch.panels.opened).toEqual([{ extensionId: DESK_EXTENSION_ID, tab: "tab-1" }]);
    expect(watch.sink.events).toContainEqual({ event: "chrome-returned", extension: "loaded", worker: true, panel: "reopened" });
    expect(watch.lock.released).toContain("launch");
  });

  it("desk watch reopens the panel only where one was open and never focuses the terminal", async () => {
    const watch = setup();
    await settle();
    watch.targets.emit({ type: "panels", open: 1 });
    watch.bridge.windowList = [win(1), win(2, { lastFocused: true })];

    await watch.restart("b-2");

    expect(watch.log.filter((line) => line.startsWith("panels.open"))).toEqual(["panels.open tab-2"]);
    expect(watch.bridge.autoOpens).toEqual([{ windowId: 2, close: false }]);
    expect(watch.bridge.focused).toEqual([]);
  });

  it("after an automatic open in the focused window, desk watch gives the keyboard back to the tab you were in", async () => {
    const watch = setup();
    await settle();
    watch.targets.emit({ type: "panels", open: 1 });
    watch.bridge.windowList = [win(1, { lastFocused: true, focused: true })];
    watch.bridge.current = "PAGE-1";

    await watch.restart("b-2");
    await pass(watch.clock, 500);

    expect(watch.log.filter((line) => line.startsWith("panels.open") || line.startsWith("pages."))).toEqual([
      "panels.open tab-1",
      "pages.bringToFront PAGE-1",
      "pages.bringToFront PAGE-1",
    ]);
  });

  it("desk watch never brings Chrome to the front when the panel's window is not the focused one", async () => {
    const watch = setup();
    await settle();
    watch.targets.emit({ type: "panels", open: 1 });
    watch.bridge.windowList = [win(1, { lastFocused: true, focused: false })];
    watch.bridge.current = "PAGE-1";

    await watch.restart("b-2");
    await pass(watch.clock, 500);

    expect(watch.panels.opened).toHaveLength(1);
    expect(watch.log.filter((line) => line.startsWith("pages."))).toEqual([]);
  });

  it("desk watch leaves the panel closed when none was open when Chrome went away", async () => {
    const watch = setup();
    await settle();
    watch.targets.emit({ type: "panels", open: 1 });
    watch.targets.emit({ type: "panels", open: 0 });
    await watch.clock.advance(5_000);
    watch.bridge.windowList = [win(1, { lastFocused: true })];

    await watch.restart("b-2");

    expect(watch.panels.opened).toEqual([]);
  });

  it("desk watch counts a panel Chrome closed while quitting as open when Chrome went away", async () => {
    const watch = setup();
    await settle();
    watch.targets.emit({ type: "panels", open: 1 });
    watch.targets.emit({ type: "panels", open: 0 });
    watch.bridge.windowList = [win(1, { lastFocused: true })];

    await watch.restart("b-2");

    expect(watch.panels.opened).toHaveLength(1);
  });

  it("desk watch never opens a panel the worker could not make open without focus", async () => {
    const watch = setup();
    await settle();
    watch.targets.emit({ type: "panels", open: 1 });
    watch.bridge.windowList = [win(1, { lastFocused: true })];
    watch.bridge.autoOpenAnswers = false;

    await watch.restart("b-2");

    expect(watch.panels.opened).toEqual([]);
  });

  it("desk watch leaves the panel to a desk that is launching, and finds it open", async () => {
    const watch = setup();
    await settle();
    watch.targets.emit({ type: "panels", open: 1 });
    watch.lock.heldBy.set("launch", 777);
    watch.bridge.windowList = [win(1, { lastFocused: true })];

    await watch.restart("b-2");
    const whileLaunching = watch.panels.opened.length;
    watch.bridge.windowList = [win(1, { lastFocused: true, panelOpen: true })];
    watch.lock.heldBy.delete("launch");
    await watch.clock.advance(200);
    await settle();

    expect(whileLaunching).toBe(0);
    expect(watch.panels.opened).toEqual([]);
    expect(watch.sink.events).toContainEqual({ event: "chrome-returned", extension: "kept", worker: true, panel: "open" });
  });

  it("desk watch relaunches Chrome after a crash at most twice in 10 minutes", async () => {
    const watch = setup();
    await settle();
    watch.profile.exit = "Crashed";
    const crash = async (id: string) => {
      watch.devTools.answering = false;
      watch.targets.drop();
      await settle();
      await watch.clock.advance(2_000);
      await settle();
      watch.devTools.browserId = id;
      watch.devTools.answering = watch.chrome.starts.length > 0;
      await watch.clock.advance(200);
      await settle();
    };

    await crash("b-2");
    await crash("b-3");
    await crash("b-4");

    expect(watch.chrome.starts).toHaveLength(2);
    expect(watch.chrome.starts[0]).toContain("--remote-debugging-port=9417");
    expect(watch.sink.events).toContainEqual({ event: "relaunch-stopped", within10Minutes: 2 });
  });

  it("desk watch relaunches after a crash when Chrome left no exit type", async () => {
    const watch = setup();
    await settle();
    watch.profile.exit = null;
    watch.devTools.answering = false;
    watch.targets.drop();
    await settle();
    await watch.clock.advance(2_000);
    await settle();

    expect(watch.chrome.starts).toHaveLength(1);
  });

  it("desk watch never relaunches after desk quit", async () => {
    const watch = setup();
    await settle();
    watch.profile.exit = "Crashed";
    await watch.files.write(MARKER, "1\n", 0o600);
    watch.devTools.answering = false;
    watch.targets.drop();
    await settle();
    await watch.clock.advance(5_000);
    await settle();

    expect(watch.chrome.starts).toEqual([]);
    expect(await watch.files.read(MARKER)).toBeNull();
  });

  it("desk watch never relaunches a Chrome the user quit", async () => {
    const watch = setup();
    await settle();
    watch.devTools.answering = false;
    watch.targets.drop();
    await settle();
    await watch.clock.advance(5_000);
    await settle();

    expect(watch.chrome.starts).toEqual([]);
  });

  it("desk watch quits Chrome after 10 minutes without a window", async () => {
    const watch = setup();
    await settle();
    watch.bridge.windowList = [];

    for (let minute = 0; minute < 10; minute += 1) await watch.clock.advance(60_000);
    const before = watch.log.filter((line) => line === "lifecycle.close").length;
    await watch.clock.advance(60_000);
    await settle();

    expect(before).toBe(0);
    expect(watch.log.filter((line) => line === "lifecycle.close")).toHaveLength(1);
    expect(await watch.files.read(MARKER)).not.toBeNull();
    expect(watch.sink.events).toContainEqual({ event: "idle-quit", minutes: 10 });
  });

  it("a window check the worker does not answer never counts toward the idle quit", async () => {
    const watch = setup();
    await settle();
    watch.bridge.windowList = null;

    for (let minute = 0; minute < 12; minute += 1) await watch.clock.advance(60_000);

    expect(watch.log).not.toContain("lifecycle.close");
  });

  it("idleQuitMinutes 0 turns the idle quit off", async () => {
    const watch = setup({ config: { ...config, chrome: { ...config.chrome, idleQuitMinutes: 0 } } });
    await settle();
    watch.bridge.windowList = [];

    for (let minute = 0; minute < 12; minute += 1) await watch.clock.advance(60_000);

    expect(watch.log).not.toContain("lifecycle.close");
  });

  it("desk watch raises the terminal-attached alert when a Desk extension target becomes attached", async () => {
    const watch = setup();
    await settle();

    watch.targets.emit({ type: "desk-attached" });
    await settle();

    expect(watch.daemon.notices).toEqual([{ type: "alert", kind: "terminal-attached" }]);
    expect(watch.sink.events).toContainEqual({ event: "terminal-attached" });
  });

  it("desk watch reopens a crashed panel in its window, closing the crashed one first", async () => {
    const watch = setup();
    await settle();
    watch.daemon.panels = [1, 2];
    watch.targets.emit({ type: "panels", open: 2 });
    await watch.clock.advance(1_000);
    await settle();

    watch.daemon.panels = [1];
    watch.targets.emit({ type: "panel-crashed" });
    watch.targets.emit({ type: "panels", open: 1 });
    await watch.clock.advance(1_000);
    await settle();

    expect(watch.bridge.autoOpens).toEqual([{ windowId: 2, close: true }]);
    expect(watch.panels.opened).toEqual([{ extensionId: DESK_EXTENSION_ID, tab: "tab-2" }]);
    expect(watch.sink.events).toContainEqual({ event: "panel-reopened", reason: "crashed" });
  });

  it("a crashed panel whose window nobody can name reopens in the last-focused window when no window shows one", async () => {
    const watch = setup();
    await settle();
    watch.bridge.windowList = [win(1), win(2, { lastFocused: true })];
    watch.daemon.panels = [];

    watch.targets.emit({ type: "panel-crashed" });
    await pass(watch.clock, 6_000);

    expect(watch.sink.events).toContainEqual({ event: "extension-recovered", reason: "panel-crashed", windows: 0, lost: 0, extension: "kept" });
    expect(watch.bridge.autoOpens).toEqual([{ windowId: 2, close: true }]);
  });

  it("a crashed panel whose window nobody can name reopens nothing while another window shows a panel", async () => {
    const watch = setup();
    await settle();

    watch.targets.emit({ type: "panel-crashed" });
    await pass(watch.clock, 6_000);

    expect(watch.panels.opened).toEqual([]);
  });

  it("a panel crash that took the service worker with it loads the extension again, then reopens the panel", async () => {
    const watch = setup();
    await settle();
    watch.bridge.windowList = [win(1, { lastFocused: true }), win(2)];
    watch.daemon.panels = [2];
    watch.targets.emit({ type: "panels", open: 1 });
    await pass(watch.clock, 1_000);
    const load = watch.extension.load.bind(watch.extension);
    watch.extension.load = async (path) => {
      const loaded = await load(path);
      watch.daemon.swConnected = true;
      return loaded;
    };

    watch.daemon.panels = [];
    watch.daemon.swConnected = false;
    watch.targets.emit({ type: "panel-crashed" });
    await pass(watch.clock, 8_000);

    expect(watch.extension.loads).toEqual([`${deskHome}/extension`]);
    expect(watch.log.indexOf("extension.load")).toBeLessThan(watch.log.indexOf("panels.open tab-2"));
    expect(watch.bridge.autoOpens).toEqual([{ windowId: 2, close: true }]);
    expect(watch.sink.events).toContainEqual({ event: "extension-recovered", reason: "panel-crashed", windows: 1, lost: 1, extension: "loaded" });
  });

  it("desk watch names a crashed panel's window from the daemon's list as the crash arrives", async () => {
    const watch = setup();
    await settle();
    watch.daemon.panels = [2];

    watch.targets.emit({ type: "panel-crashed" });
    await settle();
    watch.daemon.panels = [];
    await watch.clock.advance(400);
    await settle();

    expect(watch.bridge.autoOpens).toEqual([{ windowId: 2, close: true }]);
  });

  it("desk watch waits for the crashed panel's connection to leave the daemon before it reopens it", async () => {
    const watch = setup();
    await settle();
    watch.daemon.panels = [2];
    watch.targets.emit({ type: "panels", open: 1 });
    await watch.clock.advance(1_000);
    await settle();

    watch.targets.emit({ type: "panel-crashed" });
    await watch.clock.advance(2_000);
    await settle();
    const early = watch.panels.opened.length;
    watch.daemon.panels = [];
    await watch.clock.advance(400);
    await settle();

    expect(early).toBe(0);
    expect(watch.panels.opened).toEqual([{ extensionId: DESK_EXTENSION_ID, tab: "tab-2" }]);
  });

  it("desk watch loads the extension again when its worker is gone for two checks while Chrome runs, and reopens the panels that went with it", async () => {
    const watch = setup();
    await settle();
    watch.bridge.windowList = [win(1, { lastFocused: true }), win(2)];
    watch.daemon.panels = [2];
    watch.targets.emit({ type: "panels", open: 1 });
    await pass(watch.clock, 1_000);
    const load = watch.extension.load.bind(watch.extension);
    watch.extension.load = async (path) => {
      const loaded = await load(path);
      watch.daemon.swConnected = true;
      return loaded;
    };

    watch.daemon.swConnected = false;
    watch.daemon.panels = [];
    await pass(watch.clock, 8_000);

    expect(watch.extension.loads).toEqual([`${deskHome}/extension`]);
    expect(watch.bridge.autoOpens).toEqual([{ windowId: 2, close: true }]);
    expect(watch.sink.events).toContainEqual({ event: "extension-recovered", reason: "worker-gone", windows: 1, lost: 1, extension: "loaded" });
  });

  it("desk watch leaves a worker that is back by the next check alone", async () => {
    const watch = setup();
    await settle();

    watch.daemon.swConnected = false;
    await pass(watch.clock, 2_000);
    watch.daemon.swConnected = true;
    await pass(watch.clock, 6_000);

    expect(watch.extension.loads).toEqual([]);
  });

  it("a panel the worker counts as open but that is not connected to the daemon for three checks is closed and reopened", async () => {
    const watch = setup();
    await settle();
    watch.daemon.panels = [];
    watch.bridge.windowList = [win(1, { lastFocused: true, focused: false, panelOpen: true })];

    await pass(watch.clock, 9_000);

    expect(watch.bridge.autoOpens).toEqual([{ windowId: 1, close: true }]);
    expect(watch.panels.opened).toEqual([{ extensionId: DESK_EXTENSION_ID, tab: "tab-1" }]);
    expect(watch.extension.loads).toEqual([]);
  });

  it("a panel that is loading, connected by the next check, is left alone", async () => {
    const watch = setup();
    await settle();
    watch.daemon.panels = [];
    watch.bridge.windowList = [win(1, { lastFocused: true, panelOpen: true })];
    await pass(watch.clock, 2_000);

    watch.daemon.panels = [1];
    await pass(watch.clock, 6_000);

    expect(watch.panels.opened).toEqual([]);
  });
});
