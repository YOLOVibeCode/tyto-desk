import { describe, expect, it } from "vitest";
import {
  DESK_PORT_MAX,
  DESK_PORT_MIN,
  allocateDeskPorts,
  loadOrCreateConfig,
  newDeskConfig,
  parseDeskConfig,
  serializeDeskConfig,
  type DeskConfig,
} from "../src/index.ts";
import { FakePortProbe, MemoryConfigStore, SeqRandom } from "../src/testing/index.ts";

const home = "/Users/alex";

function config(): DeskConfig {
  return newDeskConfig({ home, platform: "darwin", chromePort: 9417, gatewayPort: 9583 });
}

/** The saved config with one value replaced, as a hand edit would leave it. */
function edited(path: string, value: unknown): string {
  const json: Record<string, unknown> = JSON.parse(serializeDeskConfig(config()));
  const keys = path.split(".");
  const last = keys.pop() ?? "";
  let node = json;
  for (const key of keys) node = node[key] as Record<string, unknown>;
  if (value === undefined) delete node[last];
  else node[last] = value;
  return JSON.stringify(json);
}

describe("config ports", () => {
  it("a new config takes two distinct free ports from 9400 to 9899 and later loads keep them", async () => {
    const store = new MemoryConfigStore();
    const probe = new FakePortProbe([9400, 9401, 9402, 9650, 9899]);
    const random = new SeqRandom([3, 141, 59, 26, 535, 89, 79]);

    const first = await loadOrCreateConfig({ store, probe, random, home, platform: "darwin" });
    if (!first.ok) throw new Error("expected a config");
    const ports = [first.config.chrome.port, first.config.gateway.port];
    probe.busy.add(first.config.chrome.port);
    probe.busy.add(first.config.gateway.port);
    const probedBefore = probe.probed.length;
    const later = await loadOrCreateConfig({ store, probe, random, home, platform: "darwin" });

    expect(first.created).toBe(true);
    expect(new Set(ports).size).toBe(2);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(9400);
      expect(port).toBeLessThanOrEqual(9899);
      expect([9400, 9401, 9402, 9650, 9899]).not.toContain(port);
    }
    expect(store.saved).toEqual([first.config]);
    expect(later).toEqual({ ok: true, created: false, config: first.config });
    expect(probe.probed).toHaveLength(probedBefore);
  });

  it("port allocation takes the only two free ports when the rest are busy", async () => {
    const busy = [];
    for (let port = DESK_PORT_MIN; port <= DESK_PORT_MAX; port += 1) if (port !== 9444 && port !== 9777) busy.push(port);

    const ports = await allocateDeskPorts(new FakePortProbe(busy), new SeqRandom([7, 11, 13]));

    expect(ports && [...ports].sort()).toEqual([9444, 9777]);
  });

  it("port allocation probes each port at most once and gives up when fewer than two are free", async () => {
    const busy = [];
    for (let port = DESK_PORT_MIN; port <= DESK_PORT_MAX; port += 1) if (port !== 9500) busy.push(port);
    const probe = new FakePortProbe(busy);

    expect(await allocateDeskPorts(probe, new SeqRandom([5]))).toBeNull();
    expect(new Set(probe.probed).size).toBe(probe.probed.length);
    expect(probe.probed).toHaveLength(500);
  });

  it("a new config is refused when fewer than two ports are free", async () => {
    const busy = [];
    for (let port = DESK_PORT_MIN; port <= DESK_PORT_MAX; port += 1) busy.push(port);
    const store = new MemoryConfigStore();

    const result = await loadOrCreateConfig({
      store,
      probe: new FakePortProbe(busy),
      random: new SeqRandom([]),
      home,
      platform: "darwin",
    });

    expect(result).toEqual({ ok: false, code: "no-free-ports" });
    expect(store.saved).toEqual([]);
  });

  it("Desk's port range leaves out 9222 and 9229", () => {
    expect([DESK_PORT_MIN, DESK_PORT_MAX]).toEqual([9400, 9899]);
  });
});

describe("config defaults", () => {
  it("a new config on macOS uses the installed Chrome and a Desk profile under Application Support", () => {
    expect(config().chrome).toEqual({
      app: "/Applications/Google Chrome.app",
      userDataDir: "/Users/alex/Library/Application Support/Desk/Chrome",
      port: 9417,
      minMajor: 155,
      extraArgs: [],
      idleQuitMinutes: 10,
      relaunchAfterCrash: true,
      setContinuePref: false,
    });
  });

  it("a new config holds the documented defaults", () => {
    const { gateway, panel, terminal, agents, version } = config();

    expect({ version, gateway, panel, terminal, agents }).toEqual({
      version: 1,
      gateway: { port: 9583, focusGuard: "auto" },
      panel: { toggleKey: "Command+Shift+Period" },
      terminal: {
        shell: null,
        tmux: null,
        scrollback: 5000,
        fontFamily: "Menlo, 'SF Mono', monospace",
        fontSize: 13,
        macOptionIsMeta: false,
        closeOnExit: true,
        osc52Write: false,
        keymap: {},
      },
      agents: { sessionPrefix: "desk", policy: "strict", idleTimeout: "15m" },
    });
  });

  it("a new config inside the Linux test container uses google-chrome-stable and a profile under ~/.config", () => {
    const linux = newDeskConfig({ home: "/home/lab", platform: "linux", chromePort: 9417, gatewayPort: 9583 });

    expect(linux.chrome.app).toBe("/usr/bin/google-chrome-stable");
    expect(linux.chrome.userDataDir).toBe("/home/lab/.config/Desk/Chrome");
    expect(linux.panel.toggleKey).toBe("Ctrl+Shift+Period");
  });

  it("a new config is refused on a platform Desk does not support", async () => {
    const result = await loadOrCreateConfig({
      store: new MemoryConfigStore(),
      probe: new FakePortProbe([]),
      random: new SeqRandom([]),
      home: "C:\\Users\\alex",
      platform: "win32",
    });

    expect(result).toEqual({ ok: false, code: "unsupported-platform" });
  });
});

describe("config schema", () => {
  it("a saved config parses back to the same config", () => {
    expect(parseDeskConfig(serializeDeskConfig(config()))).toEqual({ ok: true, config: config() });
  });

  it("the config schema refuses text that is not JSON, without quoting it", () => {
    expect(parseDeskConfig('{"version": 1, "chrome": SECRET')).toEqual({ ok: false, problem: "not-json", path: "" });
  });

  it.each([
    ["at the top level", "theme", "dark"],
    ["inside chrome", "chrome.remoteAllowOrigins", "*"],
    ["inside terminal", "terminal.cursor", "bar"],
  ])("the config schema refuses an unknown key %s", (_where, path, value) => {
    expect(parseDeskConfig(edited(path, value))).toEqual({ ok: false, problem: "unknown-key", path });
  });

  it("the config schema refuses a newer version", () => {
    expect(parseDeskConfig(edited("version", 2))).toEqual({ ok: false, problem: "newer-version", path: "version" });
  });

  it.each([
    ["version", 0],
    ["chrome.port", 9222],
    ["chrome.port", 9229],
    ["chrome.port", 0],
    ["chrome.port", 9399],
    ["chrome.port", 9900],
    ["chrome.port", 9417.5],
    ["chrome.port", "9417"],
    ["gateway.port", 9417],
    ["chrome.app", "Applications/Google Chrome.app"],
    ["chrome.userDataDir", "Library/Desk"],
    ["chrome.minMajor", 154],
    ["chrome.extraArgs", ["--lang=en", 1]],
    ["chrome.idleQuitMinutes", -1],
    ["chrome.relaunchAfterCrash", "yes"],
    ["chrome.app", undefined],
    ["gateway.focusGuard", "maybe"],
    ["panel.toggleKey", ""],
    ["terminal.shell", "zsh"],
    ["terminal.tmux", 3],
    ["terminal.scrollback", -5],
    ["terminal.scrollback", 1_000_000],
    ["terminal.fontSize", 0],
    ["terminal.keymap", { "Command+D": 1 }],
    ["agents.policy", "paused"],
    ["agents.sessionPrefix", "Desk Prefix"],
    ["agents.idleTimeout", "15 minutes"],
  ])("the config schema refuses %s = %j", (path, value) => {
    expect(parseDeskConfig(edited(path, value))).toEqual({ ok: false, problem: "invalid", path });
  });
});
