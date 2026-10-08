import { describe, expect, it } from "vitest";
import {
  DESK_EXTENSION_ORIGIN,
  NATIVE_HOST_NAME,
  agentPolicy,
  extensionIdFromKey,
  launch,
  newDeskConfig,
  parseRenderState,
  type DeskConfig,
  type DeskWindow,
} from "../src/index.ts";
import {
  FakeBrowserConnector,
  FakeChromeProcess,
  FakeChromeProfile,
  FakeChromeSettings,
  FakeClock,
  FakeDaemonClient,
  FakeDeskExtension,
  FakeDetachedSpawner,
  FakeDevToolsHttp,
  FakeExtensionBridge,
  FakeInstanceLock,
  FakeListenerInfo,
  FakePanelOpener,
  FakePortProbe,
  FakeProcessInfo,
  FakeProcessSignals,
  MemoryConfigStore,
  MemoryNativeHostDir,
  MemoryTextFiles,
  SeqRandom,
} from "../src/testing/index.ts";

const home = "/Users/alex";
const deskHome = "/Users/alex/.desk";
const appDir = "/Users/alex/.desk/app/0.3.1-dev.slice-1c+a1b2c3d";
const version = "0.3.1-dev.slice-1c+a1b2c3d";
const KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAj+EK4Sn+O8APY7SOhIYZy+HrlwEgBmaRFCHkAqe2fcpszEnoJrmmw5TKoFN9amT7Cbt22sZmyVkVh8keBCGGATL0LTTuQTe8jJbquInHgQN4cDNbw39FYBXw+++ghpmMEPMfLvbi+jMWm+ENzQqka2hhef+nhZtjZmeaoyfvnvt5euDC7XxtlANS7vyTpgdn5nTrj8TF34sRwbNcppfUvlDafZ7qtUTTw8mo3hJMdg7K3zF/gLQei0J6rqU8Jn/FMD2GCpngepvYaPcVd72zCKjBerKEqQXQvUJEo/uEho5ZW153NkYTjckCUKEC9aSAYmnBXfvN57wvRlqFMDhVLQIDAQAB";
const keyId = extensionIdFromKey(KEY);
const template = {
  manifest_version: 3,
  name: "Tyto Desk",
  version: "0.0.0",
  key: KEY,
  commands: { "toggle-terminal": { suggested_key: { mac: "Command+Shift+Period", default: "Ctrl+Shift+Period" } } },
};
const config = newDeskConfig({ home, platform: "darwin", chromePort: 9417, gatewayPort: 9583 });
const watchCommand = { file: `${appDir}/Desk Terminal.app/Contents/MacOS/Desk Terminal`, args: [`${appDir}/desk.mjs`, "watch"], env: { HOME: home, DESK_HOME: deskHome } };

const HOST = "alex-mac";
const EXE = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const win = (id: number, change: Partial<DeskWindow> = {}): DeskWindow => ({ id, focused: false, lastFocused: false, panelOpen: false, ...change });

/**
 * A Desk Chrome the test plays: it answers /json/version once started, its worker reaches the daemon a few polls after
 * the extension loads, and the toolbar action opens the panel in the tab's window, whose panel then says hello.
 */
function setup(
  options: {
    windows?: DeskWindow[];
    tabs?: [number, string][];
    workerAfterLists?: number;
    config?: DeskConfig;
    settings?: Partial<Record<"background_mode.enabled" | "session.restore_on_startup", unknown>>;
    preferencesExist?: boolean;
  } = {},
) {
  const log: string[] = [];
  const clock = new FakeClock({ auto: true });
  const chrome = new FakeChromeProcess("155.0.8059.40", log);
  const devTools = new FakeDevToolsHttp({ log });
  const extension = new FakeDeskExtension({ loadAs: keyId, log });
  const panels = new FakePanelOpener(log);
  const settings = new FakeChromeSettings(options.settings ?? {}, log);
  const browser = new FakeBrowserConnector(extension, panels, log, { settings });
  const daemon = new FakeDaemonClient({ reachable: false, log });
  const bridge = new FakeExtensionBridge(options.windows ?? [win(1, { focused: true, lastFocused: true })]);
  const files = new MemoryTextFiles({
    [`${appDir}/extension/manifest.json`]: JSON.stringify(template),
    [`${appDir}/extension/sw.js`]: "// worker",
    [`${appDir}/extension/panel.html`]: "<!doctype html>",
  });
  const hosts = new MemoryNativeHostDir();
  const profile = new FakeChromeProfile({ preferencesExist: options.preferencesExist ?? false });
  const processes = new FakeProcessInfo();
  const listeners = new FakeListenerInfo();
  const probe = new FakePortProbe();
  const lock = new FakeInstanceLock();
  const spawner = new FakeDetachedSpawner();
  const signals = new FakeProcessSignals(log);
  spawner.onStart = () => log.push("watch started");
  const store = new MemoryConfigStore(options.config ?? config);
  for (const [id, tab] of options.tabs ?? [[1, "tab-1"]]) panels.tabs.set(id, tab);
  const tabWindow = new Map([...panels.tabs].map(([id, tab]) => [tab, id]));

  // A Chrome that starts takes the profile's SingletonLock and listens on the port its arguments name.
  chrome.onStart = () => {
    devTools.answering = true;
    devTools.silentProbes = 3;
    const args = chrome.starts.at(-1) ?? [];
    const port = Number(args.find((arg) => arg.startsWith("--remote-debugging-port="))?.split("=")[1]);
    const line = [EXE, ...args].join(" ");
    profile.lock = { host: HOST, pid: 5100 };
    processes.live.add(5100);
    processes.args.set(5100, line);
    listeners.listeners.set(port, 5100);
    listeners.images.set(5100, { exe: EXE, args: line });
  };
  let loadedAtList = -1;
  daemon.onRequest = (request, lists) => {
    if (extension.loads.length > 0 && loadedAtList < 0) loadedAtList = lists;
    if (loadedAtList >= 0 && lists - loadedAtList >= (options.workerAfterLists ?? 2)) {
      daemon.swConnected = true;
      daemon.swConnects = 1;
    }
  };
  extension.loadVersion = "0.3.1.1";
  const originalLoad = extension.load.bind(extension);
  extension.load = async (path) => {
    const loaded = await originalLoad(path);
    daemon.reachable = true;
    return loaded;
  };
  panels.onOpen = (tab) => {
    const id = tabWindow.get(tab);
    if (id === undefined) return;
    daemon.panels.push(id);
    const shown = bridge.windowList?.find((w) => w.id === id);
    if (shown !== undefined) shown.panelOpen = true;
    log.push(`panel hello in window ${id}`);
  };

  const run = () =>
    launch(
      {
        lock,
        config: store,
        probe,
        random: new SeqRandom([1]),
        clock,
        chromeFor: () => ({ chrome, profile, hosts }),
        processes,
        listeners,
        devTools,
        browser,
        daemon,
        bridge,
        files,
        spawner,
        signals,
      },
      { home, deskHome, platform: "darwin", host: HOST, version, appDir, watchCommand },
    );
  return { log, clock, chrome, devTools, extension, panels, settings, browser, daemon, bridge, files, hosts, profile, processes, listeners, probe, lock, spawner, signals, store, run };
}

describe("desk, a fresh launch", () => {
  it("launch waits for /json/version before connecting", async () => {
    const desk = setup();

    const result = await desk.run();

    expect(result).toMatchObject({ ok: true });
    expect(desk.devTools.probed.length).toBeGreaterThanOrEqual(4);
    expect(desk.log.indexOf("json/version answered")).toBeLessThan(desk.log.indexOf("browser.connect"));
    expect(desk.browser.connected).toEqual(["ws://127.0.0.1:9417/devtools/browser/0b5ad5d6-0000-4000-8000-000000000001"]);
    expect(desk.clock.sleeps.filter((ms) => ms === 100).length).toBeGreaterThanOrEqual(3);
  });

  it("launch refuses an extension id that differs from the key's id", async () => {
    const desk = setup();
    desk.extension.loadAs = "abcdefghijklmnopabcdefghijklmnop";

    const result = await desk.run();

    expect(result).toEqual({
      ok: false,
      code: 70,
      message: `Chrome loaded the Desk extension as abcdefghijklmnopabcdefghijklmnop, not as ${keyId}, the id its key gives`,
    });
    expect(desk.panels.opened).toEqual([]);
  });

  it("launch waits for the service worker's hello before opening the panel", async () => {
    const desk = setup({ workerAfterLists: 4 });

    await desk.run();
    const workerUp = desk.log.indexOf("daemon.list sw=true");
    const opened = desk.log.findIndex((entry) => entry.startsWith("panels.open"));

    expect(desk.log.filter((entry) => entry === "daemon.list sw=false").length).toBeGreaterThanOrEqual(3);
    expect(workerUp).toBeGreaterThan(-1);
    expect(opened).toBeGreaterThan(workerUp);
  });

  it("launch opens the panel in the last-focused window with Extensions.triggerAction", async () => {
    const desk = setup({
      windows: [win(1, { focused: false }), win(2, { lastFocused: true }), win(3)],
      tabs: [[1, "tab-1"], [2, "tab-2"], [3, "tab-3"]],
    });

    const result = await desk.run();

    expect(desk.panels.opened).toEqual([{ extensionId: keyId, tab: "tab-2" }]);
    expect(desk.log).toContain("panel hello in window 2");
    expect(result).toEqual({ ok: true, message: expect.stringMatching(/^Desk ready \(port 9417, guarded 9583, Chrome 155\.0\.8059\.40\) in \d+\.\d s$/) });
  });

  it("launch opens a window first when Chrome has no normal window", async () => {
    const desk = setup({ windows: [], tabs: [[5, "tab-5"]] });
    desk.panels.onNewWindow = () => {
      desk.bridge.windowList = [win(5, { focused: true, lastFocused: true })];
    };

    const result = await desk.run();

    expect(desk.panels.newWindows).toBe(1);
    expect(desk.log.indexOf("panels.newWindow")).toBeLessThan(desk.log.indexOf("panels.open tab-5"));
    expect(desk.panels.opened).toEqual([{ extensionId: keyId, tab: "tab-5" }]);
    expect(result).toEqual({ ok: true, message: expect.stringMatching(/in \d+\.\d s\. Cmd\+Shift\+T reopens the window you closed$/) });
  });

  it("launch starts Chrome with chromeArgs' arguments for the stored port and the Desk profile", async () => {
    const desk = setup();

    await desk.run();

    expect(desk.chrome.starts).toEqual([
      [
        "--remote-debugging-port=9417",
        "--user-data-dir=/Users/alex/Library/Application Support/Desk/Chrome",
        "--no-first-run",
        "--no-default-browser-check",
        "--restore-last-session",
        "--hide-crash-restore-bubble",
      ],
    ]);
  });

  it("every launch writes the Desk host manifest, the rendered extension, the agent config, and a policy when there is none", async () => {
    const desk = setup();

    await desk.run();
    const manifest = JSON.parse(desk.files.text(`${deskHome}/extension/manifest.json`));

    expect(JSON.parse(desk.hosts.manifests.get(NATIVE_HOST_NAME) ?? "{}")).toEqual({
      name: NATIVE_HOST_NAME,
      description: "Tyto Desk terminal relay",
      path: `${deskHome}/bin/desk-nmhost`,
      type: "stdio",
      allowed_origins: [DESK_EXTENSION_ORIGIN],
    });
    expect(manifest).toMatchObject({ version: "0.3.1.1", version_name: version, key: KEY });
    expect(desk.files.text(`${deskHome}/extension/sw.js`)).toBe("// worker");
    expect(desk.files.text(`${deskHome}/extension/panel.html`)).toBe("<!doctype html>");
    expect(parseRenderState(desk.files.text(`${deskHome}/render.json`))).toEqual({ version: 1, serial: 1, deskVersion: version, toggleKey: "Command+Shift+Period" });
    expect(JSON.parse(desk.files.text(`${deskHome}/agent-browser.json`))).toMatchObject({ cdp: "http://127.0.0.1:9583" });
    expect(JSON.parse(desk.files.text(`${deskHome}/agent-policy.json`))).toEqual(agentPolicy("open"));
    for (const path of [`${deskHome}/render.json`, `${deskHome}/agent-browser.json`, `${deskHome}/agent-policy.json`]) {
      expect(desk.files.files.get(path)?.mode).toBe(0o600);
    }
  });

  it("a new install writes the open policy", async () => {
    const desk = setup();

    await desk.run();

    expect(JSON.parse(desk.files.text(`${deskHome}/agent-policy.json`))).toEqual(agentPolicy("open"));
  });

  it("a launch keeps the agent policy the user chose", async () => {
    const desk = setup();
    await desk.files.write(`${deskHome}/agent-policy.json`, JSON.stringify(agentPolicy("strict")), 0o600);

    await desk.run();

    expect(JSON.parse(desk.files.text(`${deskHome}/agent-policy.json`))).toEqual(agentPolicy("strict"));
  });

  it("the first launch seeds the side panel on the left, 640 px wide, before Chrome starts", async () => {
    const desk = setup();

    await desk.run();

    expect(desk.profile.seeded).toEqual([{ side_panel: { is_right_aligned: false, id_to_width: { kExtension: 640 } } }]);
  });

  it("launch skips loading the extension when Chrome already has the rendered version", async () => {
    const desk = setup();
    desk.extension.installed.set(keyId, "0.3.1.1");
    desk.daemon.reachable = true;
    desk.daemon.swConnected = true;

    const result = await desk.run();

    expect(result).toMatchObject({ ok: true });
    expect(desk.extension.loads).toEqual([]);
  });

  it("launch exits 70 naming a damaged install, before Chrome starts, when the installed manifest's key is not base64", async () => {
    const desk = setup();
    await desk.files.write(`${appDir}/extension/manifest.json`, JSON.stringify({ ...template, key: "not base64!" }), 0o600);

    const result = await desk.run();

    expect(result).toMatchObject({ ok: false, code: 70, message: expect.stringContaining("damaged") });
    expect(desk.chrome.starts).toEqual([]);
  });

  it("launch exits 70 naming the Developer-mode fallback when Chrome refuses to load the extension", async () => {
    const desk = setup();
    desk.extension.loadAs = null;

    const result = await desk.run();

    expect(result).toMatchObject({ ok: false, code: 70 });
    expect(result.ok ? "" : result.message).toMatch(/Developer mode.*Load unpacked.*\/Users\/alex\/\.desk\/extension/);
  });

  it("launch wakes a service worker that did not connect within 5 s with the toolbar action", async () => {
    const desk = setup({ workerAfterLists: 1_000 });
    const opensPanel = desk.panels.onOpen;
    desk.panels.onOpen = (tab) => {
      if (desk.daemon.swConnected) opensPanel(tab);
      else desk.daemon.swConnected = true;
    };

    const result = await desk.run();

    expect(result).toMatchObject({ ok: true });
    expect(desk.panels.opened).toEqual([
      { extensionId: keyId, tab: "tab-1" },
      { extensionId: keyId, tab: "tab-1" },
    ]);
    expect(desk.clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(5_000);
  });

  it("launch exits 70 when the service worker never reaches the daemon", async () => {
    const desk = setup({ workerAfterLists: 1_000 });

    const result = await desk.run();

    expect(result).toMatchObject({ ok: false, code: 70, message: expect.stringContaining("service worker") });
  });

  it.each([
    ["no Chrome installed", null],
    ["a Chrome older than the minimum", "154.0.7000.1"],
  ])("launch exits 69 with %s", async (_label, installed) => {
    const desk = setup();
    desk.chrome.installed = installed;

    expect(await desk.run()).toMatchObject({ ok: false, code: 69 });
    expect(desk.chrome.starts).toEqual([]);
  });

  it("launch starts Chrome when the singleton it finds names a dead process", async () => {
    const desk = setup();
    desk.profile.lock = { host: "alex-mac", pid: 4242 };

    expect(await desk.run()).toMatchObject({ ok: true });
    expect(desk.chrome.starts).toHaveLength(1);
  });

  it("launch holds run/launch.lock and releases it", async () => {
    const desk = setup();

    await desk.run();

    expect(desk.lock.acquired).toEqual(["launch"]);
    expect(desk.lock.released).toEqual(["launch"]);
  });

  it("a second desk waits up to 10 s for the first one's lock, then exits 75 without starting Chrome", async () => {
    const desk = setup();
    desk.lock.heldBy.set("launch", 777);

    const result = await desk.run();

    expect(result).toMatchObject({ ok: false, code: 75 });
    expect(desk.clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(10_000);
    expect(desk.chrome.starts).toEqual([]);
  });

  it("launch exits 70 when Chrome never answers /json/version within 20 s", async () => {
    const desk = setup();
    desk.chrome.onStart = () => undefined;

    const result = await desk.run();

    expect(result).toMatchObject({ ok: false, code: 70 });
    expect(desk.clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(20_000);
    expect(desk.browser.connected).toEqual([]);
  });
});

describe("desk, Chrome's settings at launch", () => {
  it("first run turns background mode off where Chrome has the pref and reads it back", async () => {
    const desk = setup({ settings: { "background_mode.enabled": true } });

    const result = await desk.run();

    expect(result).toMatchObject({ ok: true });
    expect(desk.settings.calls).toEqual(["get background_mode.enabled", "set background_mode.enabled false", "get background_mode.enabled"]);
    expect(desk.settings.prefs.get("background_mode.enabled")).toBe(false);
  });

  it("first run writes nothing when this Chrome has no background mode pref", async () => {
    const desk = setup();

    const result = await desk.run();

    expect(result).toEqual({ ok: true, message: expect.stringMatching(/^Desk ready .* in \d+\.\d s$/) });
    expect(desk.settings.calls).toEqual(["get background_mode.enabled"]);
  });

  it("a later launch leaves background mode alone", async () => {
    const desk = setup({ settings: { "background_mode.enabled": true }, preferencesExist: true });

    await desk.run();

    expect(desk.settings.calls).toEqual([]);
    expect(desk.settings.prefs.get("background_mode.enabled")).toBe(true);
  });

  it.each([
    ["Chrome keeps it on", { ignoreWrites: true }],
    ["Chrome's settings page cannot be reached", { unavailable: true }],
  ])("first run says how to turn background mode off when %s", async (_, failure) => {
    const desk = setup({ settings: { "background_mode.enabled": true } });
    Object.assign(desk.settings, failure);

    const result = await desk.run();

    expect(result).toEqual({
      ok: true,
      message: expect.stringMatching(
        /in \d+\.\d s\. Chrome's background mode may still be on: turn off "Continue running background apps when Google Chrome is closed" in Settings > System, so the Desk Chrome does not keep running with its port open after Cmd\+Q$/,
      ),
    });
  });

  it("launch never writes session.restore_on_startup unless setContinuePref is on", async () => {
    const desk = setup({ settings: { "session.restore_on_startup": 5 } });

    await desk.run();

    expect(desk.settings.calls.filter((call) => call.includes("session.restore_on_startup"))).toEqual([]);
    expect(desk.settings.prefs.get("session.restore_on_startup")).toBe(5);
  });

  it("launch sets session.restore_on_startup to 1 when setContinuePref is on", async () => {
    const desk = setup({
      config: { ...config, chrome: { ...config.chrome, setContinuePref: true } },
      settings: { "session.restore_on_startup": 5 },
      preferencesExist: true,
    });

    await desk.run();

    expect(desk.settings.calls).toEqual(["get session.restore_on_startup", "set session.restore_on_startup 1"]);
    expect(desk.settings.prefs.get("session.restore_on_startup")).toBe(1);
  });

  it("launch leaves session.restore_on_startup alone when it is already 1", async () => {
    const desk = setup({
      config: { ...config, chrome: { ...config.chrome, setContinuePref: true } },
      settings: { "session.restore_on_startup": 1 },
      preferencesExist: true,
    });

    await desk.run();

    expect(desk.settings.calls).toEqual(["get session.restore_on_startup"]);
  });

  it("launch writes Chrome's settings after the service worker reaches the daemon and before it opens the panel", async () => {
    const desk = setup({ settings: { "background_mode.enabled": true } });

    await desk.run();
    const workerUp = desk.log.indexOf("daemon.list sw=true");
    const written = desk.log.indexOf("settings.set background_mode.enabled");
    const opened = desk.log.findIndex((entry) => entry.startsWith("panels.open"));

    expect(workerUp).toBeGreaterThan(-1);
    expect(written).toBeGreaterThan(workerUp);
    expect(opened).toBeGreaterThan(written);
  });
});

describe("desk watch at launch (§6.1 step 13)", () => {
  it.each([
    ["free", null, 1],
    ["held by a live watch of this version", version, 0],
  ])("desk starts desk watch when run/watch.lock is free and leaves a live watch of its own version running (%s)", async (_, build, starts) => {
    const desk = setup();
    if (build !== null) desk.lock.holders.set("watch", { pid: 5151, build });

    const result = await desk.run();

    expect(result).toMatchObject({ ok: true });
    expect(desk.spawner.started).toEqual(starts === 1 ? [watchCommand] : []);
    expect(desk.signals.terminated).toEqual([]);
  });

  it("desk replaces a desk watch that runs another version and never stops the daemon", async () => {
    const desk = setup();
    desk.lock.holders.set("watch", { pid: 5151, build: "0.2.0" });
    desk.signals.onTerminate = () => desk.lock.holders.delete("watch");

    const result = await desk.run();

    expect(result).toMatchObject({ ok: true });
    expect(desk.signals.terminated).toEqual([5151]);
    expect(desk.spawner.started).toEqual([watchCommand]);
    expect(desk.log.indexOf("signals.terminate 5151")).toBeLessThan(desk.log.indexOf("watch started"));
    expect(desk.daemon.notices).toEqual([]);
  });

  it("desk starts desk watch after the panel opens", async () => {
    const desk = setup();

    await desk.run();

    expect(desk.log.indexOf("panel hello in window 1")).toBeLessThan(desk.log.indexOf("watch started"));
  });

  it("desk says agents cannot reach the guarded endpoint when desk watch does not start, and the panel still opens", async () => {
    const desk = setup();
    desk.spawner.failing = true;

    const result = await desk.run();

    expect(result).toEqual({
      ok: true,
      message: expect.stringMatching(/in \d+\.\d s\. desk watch did not start, so agents cannot reach the guarded endpoint until the next desk; desk cdp --raw still works$/),
    });
    expect(desk.daemon.panels).toEqual([1]);
  });

  it("desk does not start a second watch while the older one has not let go of its lock within 10 s", async () => {
    const desk = setup();
    desk.lock.holders.set("watch", { pid: 5151, build: "0.2.0" });

    const result = await desk.run();

    expect(desk.signals.terminated).toEqual([5151]);
    expect(desk.spawner.started).toEqual([]);
    expect(result).toEqual({ ok: true, message: expect.stringMatching(/desk watch did not start/) });
  });
});

describe("desk, reuse and classification (slice 3b, §6.1 step 4, §6.2)", () => {
  /** A Desk Chrome that one `desk` already started, and whose watch holds its lock. */
  async function running(options: Parameters<typeof setup>[0] = {}) {
    const desk = setup(options);
    desk.spawner.onStart = () => desk.lock.holders.set("watch", { pid: 6200, build: version });
    expect(await desk.run()).toMatchObject({ ok: true });
    desk.log.length = 0;
    return desk;
  }

  it("reuse connects to the running Desk Chrome without starting, seeding or configuring it", async () => {
    const desk = await running();

    const result = await desk.run();

    expect(result).toEqual({ ok: true, message: expect.stringMatching(/^Desk ready \(port 9417, guarded 9583, Chrome 155\.0\.8059\.40\) in \d+\.\d s$/) });
    expect(desk.chrome.starts).toHaveLength(1);
    expect(desk.profile.seeded).toHaveLength(1);
    expect(desk.browser.connected).toHaveLength(2);
    expect(desk.log).not.toContain("extension.load");
    expect(desk.log.filter((line) => line.startsWith("settings."))).toEqual([]);
  });

  it("reuse focuses the window that already shows the panel", async () => {
    const desk = await running({ windows: [win(1, { lastFocused: true }), win(2)], tabs: [[1, "tab-1"], [2, "tab-2"]] });
    desk.bridge.windowList = [win(1), win(2, { lastFocused: true, focused: true, panelOpen: true })];
    desk.daemon.panels = [2];
    const opened = desk.panels.opened.length;

    await desk.run();

    expect(desk.bridge.focused).toEqual([2]);
    expect(desk.panels.opened).toHaveLength(opened);
  });

  it("reuse opens the panel in a window the worker counts as showing it when no panel there said hello within 2 s", async () => {
    const desk = await running();
    desk.daemon.panels = [];
    desk.bridge.windowList = [win(1, { lastFocused: true, focused: true, panelOpen: true })];
    const opened = desk.panels.opened.length;

    const result = await desk.run();

    expect(result).toMatchObject({ ok: true });
    expect(desk.panels.opened).toHaveLength(opened + 1);
    expect(desk.bridge.focused).toEqual([]);
  });

  it("reuse wakes a service worker that did not connect with the toolbar action", async () => {
    const desk = await running();
    desk.daemon.swConnected = false;
    desk.panels.onOpen = () => {
      desk.daemon.swConnected = true;
    };

    const result = await desk.run();

    expect(result).toMatchObject({ ok: true });
    expect(desk.panels.opened.at(-1)).toEqual({ extensionId: keyId, tab: "tab-1" });
  });

  it("reuse loads the extension again when Chrome has another version of it", async () => {
    const desk = await running();
    desk.extension.installed.set(keyId, "0.3.0.4");

    await desk.run();

    expect(desk.log).toContain("extension.load");
  });

  it("two desk runs never trigger the panel twice", async () => {
    const desk = setup();
    desk.spawner.onStart = () => desk.lock.holders.set("watch", { pid: 6200, build: version });

    const results = await Promise.all([desk.run(), desk.run()]);

    expect(results).toMatchObject([{ ok: true }, { ok: true }]);
    expect(desk.chrome.starts).toHaveLength(1);
    expect(desk.panels.opened).toHaveLength(1);
    expect(desk.bridge.focused).toEqual([1]);
  });

  it("launch exits 75 naming the port when another program listens on it while the Desk Chrome runs", async () => {
    const desk = await running();
    desk.listeners.listeners.set(9417, 7777);
    desk.listeners.images.set(7777, { exe: "/usr/local/bin/socat", args: "socat TCP-LISTEN:9417" });

    const result = await desk.run();

    expect(result).toEqual({
      ok: false,
      code: 75,
      message: "port 9417 is held by another program while the Desk Chrome runs; quit the Desk Chrome (Cmd+Q) and run desk",
    });
    expect(desk.browser.connected).toHaveLength(1);
  });

  it("a busy port while the Desk Chrome is down moves Chrome to a new raw port and keeps the guarded port", async () => {
    const desk = setup();
    desk.probe.busy.add(9417);

    const result = await desk.run();
    const saved = await desk.store.load();

    expect(saved?.chrome.port).not.toBe(9417);
    expect(saved?.gateway.port).toBe(9583);
    expect(desk.chrome.starts[0]).toContain(`--remote-debugging-port=${saved?.chrome.port}`);
    expect(result).toEqual({
      ok: true,
      message: expect.stringContaining(`port 9417 was in use, so the Desk Chrome now uses port ${saved?.chrome.port}; agents keep the guarded port 9583`),
    });
  });

  it("moving the raw port replaces desk watch, so its guarded endpoint follows Chrome", async () => {
    const desk = setup();
    desk.probe.busy.add(9417);
    desk.lock.holders.set("watch", { pid: 5151, build: version });
    desk.signals.onTerminate = () => desk.lock.holders.delete("watch");

    await desk.run();

    expect(desk.signals.terminated).toEqual([5151]);
    expect(desk.spawner.started).toEqual([watchCommand]);
  });

  it("desk waits up to 10 s for a quitting Desk Chrome before launching", async () => {
    const desk = setup();
    desk.profile.lock = { host: HOST, pid: 4242 };
    desk.processes.live.add(4242);
    desk.processes.args.set(4242, `${EXE} --user-data-dir=${config.chrome.userDataDir}`);
    const alive = desk.processes.alive.bind(desk.processes);
    let asked = 0;
    desk.processes.alive = async (pid) => {
      asked += 1;
      if (asked === 5) desk.processes.live.delete(4242);
      return alive(pid);
    };

    const result = await desk.run();

    expect(result).toMatchObject({ ok: true });
    expect(desk.chrome.starts).toHaveLength(1);
    expect(desk.clock.sleeps.length).toBeGreaterThan(0);
  });

  it("desk exits 75 when the Desk Chrome stays up without its debugging port for 10 s", async () => {
    const desk = setup();
    desk.profile.lock = { host: HOST, pid: 4242 };
    desk.processes.live.add(4242);
    desk.processes.args.set(4242, `${EXE} --user-data-dir=${config.chrome.userDataDir}`);

    const result = await desk.run();

    expect(result).toEqual({ ok: false, code: 75, message: "the Desk Chrome is running without its debugging port; quit it with Cmd+Q" });
    expect(desk.clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(10_000);
    expect(desk.chrome.starts).toEqual([]);
  });

  it("a live pid the system gave to another process does not count as the Desk Chrome", async () => {
    const desk = setup();
    desk.profile.lock = { host: HOST, pid: 4242 };
    desk.processes.live.add(4242);
    desk.processes.args.set(4242, "/usr/sbin/cupsd -l");

    expect(await desk.run()).toMatchObject({ ok: true });
    expect(desk.chrome.starts).toHaveLength(1);
  });

  it("a launch removes the quit marker an earlier desk quit left, so desk watch relaunches the next crash", async () => {
    const desk = setup();
    await desk.files.write(`${deskHome}/run/quit.marker`, "1\n", 0o600);

    await desk.run();

    expect(await desk.files.read(`${deskHome}/run/quit.marker`)).toBeNull();
  });

  it("reuse leaves a quit marker alone, since desk quit may be closing Chrome right now", async () => {
    const desk = await running();
    await desk.files.write(`${deskHome}/run/quit.marker`, "1\n", 0o600);

    await desk.run();

    expect(await desk.files.read(`${deskHome}/run/quit.marker`)).toBe("1\n");
  });

  it("a dead singleton lock naming another host is removed when no process uses the profile", async () => {
    const desk = setup();
    desk.profile.lock = { host: "old-name.local", pid: 4242 };

    await desk.run();

    expect(desk.profile.cleared).toBe(1);
    expect(desk.log.indexOf("chrome.start")).toBeGreaterThanOrEqual(0);
  });

  it("a dead singleton lock naming another host stays while some process uses the profile", async () => {
    const desk = setup();
    desk.profile.lock = { host: "old-name.local", pid: 4242 };
    desk.processes.live.add(8080);
    desk.processes.args.set(8080, `/opt/helper --user-data-dir=${config.chrome.userDataDir}`);

    await desk.run();

    expect(desk.profile.cleared).toBe(0);
  });
});
