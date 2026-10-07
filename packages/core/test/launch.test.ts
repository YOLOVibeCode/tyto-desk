import { describe, expect, it } from "vitest";
import {
  DESK_EXTENSION_ORIGIN,
  NATIVE_HOST_NAME,
  agentPolicy,
  extensionIdFromKey,
  launch,
  newDeskConfig,
  parseRenderState,
  type DeskWindow,
} from "../src/index.ts";
import {
  FakeBrowserConnector,
  FakeChromeProcess,
  FakeChromeProfile,
  FakeClock,
  FakeDaemonClient,
  FakeDeskExtension,
  FakeDevToolsHttp,
  FakeExtensionBridge,
  FakeInstanceLock,
  FakePanelOpener,
  FakePortProbe,
  FakeProcessInfo,
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

const win = (id: number, change: Partial<DeskWindow> = {}): DeskWindow => ({ id, focused: false, lastFocused: false, panelOpen: false, ...change });

/**
 * A Desk Chrome the test plays: it answers /json/version once started, its worker reaches the daemon a few polls after
 * the extension loads, and the toolbar action opens the panel in the tab's window, whose panel then says hello.
 */
function setup(options: { windows?: DeskWindow[]; tabs?: [number, string][]; workerAfterLists?: number } = {}) {
  const log: string[] = [];
  const clock = new FakeClock({ auto: true });
  const chrome = new FakeChromeProcess("155.0.8059.40", log);
  const devTools = new FakeDevToolsHttp({ log });
  const extension = new FakeDeskExtension({ loadAs: keyId, log });
  const panels = new FakePanelOpener(log);
  const browser = new FakeBrowserConnector(extension, panels, log);
  const daemon = new FakeDaemonClient({ reachable: false, log });
  const bridge = new FakeExtensionBridge(options.windows ?? [win(1, { focused: true, lastFocused: true })]);
  const files = new MemoryTextFiles({
    [`${appDir}/extension/manifest.json`]: JSON.stringify(template),
    [`${appDir}/extension/sw.js`]: "// worker",
    [`${appDir}/extension/panel.html`]: "<!doctype html>",
  });
  const hosts = new MemoryNativeHostDir();
  const profile = new FakeChromeProfile();
  const processes = new FakeProcessInfo();
  const lock = new FakeInstanceLock();
  const store = new MemoryConfigStore(config);
  for (const [id, tab] of options.tabs ?? [[1, "tab-1"]]) panels.tabs.set(id, tab);
  const tabWindow = new Map([...panels.tabs].map(([id, tab]) => [tab, id]));

  chrome.onStart = () => {
    devTools.answering = true;
    devTools.silentProbes = 3;
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
    log.push(`panel hello in window ${id}`);
  };

  const run = () =>
    launch(
      {
        lock,
        config: store,
        probe: new FakePortProbe(),
        random: new SeqRandom([1]),
        clock,
        chromeFor: () => ({ chrome, profile, hosts }),
        processes,
        devTools,
        browser,
        daemon,
        bridge,
        files,
      },
      { home, deskHome, platform: "darwin", version, appDir },
    );
  return { log, clock, chrome, devTools, extension, panels, browser, daemon, bridge, files, hosts, profile, processes, lock, store, run };
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
    expect(JSON.parse(desk.files.text(`${deskHome}/agent-browser.json`))).toMatchObject({ cdp: "http://127.0.0.1:9417" });
    expect(JSON.parse(desk.files.text(`${deskHome}/agent-policy.json`))).toEqual(agentPolicy("open"));
    for (const path of [`${deskHome}/render.json`, `${deskHome}/agent-browser.json`, `${deskHome}/agent-policy.json`]) {
      expect(desk.files.files.get(path)?.mode).toBe(0o600);
    }
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

  it("launch exits 75 without starting Chrome while the Desk Chrome's singleton is alive (reuse comes in slice 3b)", async () => {
    const desk = setup();
    desk.profile.lock = { host: "alex-mac", pid: 4242 };
    desk.processes.live.add(4242);

    const result = await desk.run();

    expect(result).toMatchObject({ ok: false, code: 75 });
    expect(desk.chrome.starts).toEqual([]);
  });

  it("launch starts Chrome when the singleton it finds names a dead process", async () => {
    const desk = setup();
    desk.profile.lock = { host: "alex-mac", pid: 4242 };

    expect(await desk.run()).toMatchObject({ ok: true });
    expect(desk.chrome.starts).toHaveLength(1);
  });

  it("launch exits 75 without starting Chrome when something already answers on the Desk port", async () => {
    const desk = setup();
    desk.devTools.answering = true;

    expect(await desk.run()).toMatchObject({ ok: false, code: 75, message: expect.stringContaining("port 9417") });
    expect(desk.chrome.starts).toEqual([]);
  });

  it("launch holds run/launch.lock and releases it", async () => {
    const desk = setup();

    await desk.run();

    expect(desk.lock.acquired).toEqual(["launch"]);
    expect(desk.lock.released).toEqual(["launch"]);
  });

  it("a second desk waits up to 10 s for the first one's lock, then exits 75 (reuse comes in slice 3b)", async () => {
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
