import { describe, expect, it } from "vitest";
import { newDeskConfig, quit } from "../src/index.ts";
import {
  FakeBrowserConnector,
  FakeBrowserLifecycle,
  FakeChromeProfile,
  FakeChromeSettings,
  FakeClock,
  FakeDaemonClient,
  FakeDeskExtension,
  FakeDevToolsHttp,
  FakeInstanceLock,
  FakePanelOpener,
  FakeProcessInfo,
  FakeProcessSignals,
  MemoryConfigStore,
  MemoryLogSink,
  MemoryTextFiles,
  ScriptedPrompter,
} from "../src/testing/index.ts";

const home = "/Users/alex";
const deskHome = "/Users/alex/.desk";
const config = newDeskConfig({ home, platform: "darwin", chromePort: 9417, gatewayPort: 9583 });
const CHROME_PID = 4242;

/**
 * A running Desk Chrome the test plays: its singleton names a live pid, it answers /json/version, and Browser.close
 * makes it stop answering. Every port is a fake; the daemon and desk watch run unless the test says otherwise.
 */
function setup(options: { answers?: boolean; singleton?: boolean; closes?: boolean; consent?: (boolean | "no-tty")[] } = {}) {
  const log: string[] = [];
  const clock = new FakeClock({ auto: true });
  const devTools = new FakeDevToolsHttp({ answering: options.answers ?? true, log });
  const lifecycle = new FakeBrowserLifecycle(log);
  const browser = new FakeBrowserConnector(new FakeDeskExtension({ log }), new FakePanelOpener(log), log, {
    settings: new FakeChromeSettings(),
    lifecycle,
  });
  const profile = new FakeChromeProfile({ lock: options.singleton === false ? null : { host: "alex-mac", pid: CHROME_PID } });
  const processes = new FakeProcessInfo([CHROME_PID]);
  const daemon = new FakeDaemonClient({ reachable: true, log });
  const lock = new FakeInstanceLock();
  lock.heldBy.set("watch", 5151);
  const signals = new FakeProcessSignals(log);
  const files = new MemoryTextFiles();
  const prompter = new ScriptedPrompter(options.consent ?? []);
  const audit = new MemoryLogSink();
  lifecycle.onClose = () => {
    if (options.closes !== false) devTools.answering = false;
  };
  const run = (all = false) =>
    quit(
      { config: new MemoryConfigStore(config), profileFor: () => profile, processes, devTools, browser, files, clock, lock, signals, daemon, prompter, log: audit },
      { deskHome, all },
    );
  return { log, audit, clock, devTools, lifecycle, browser, profile, processes, daemon, lock, signals, files, prompter, run };
}

describe("desk quit", () => {
  it("desk quit sends Browser.close and never a signal", async () => {
    const desk = setup();

    const result = await desk.run();

    expect(result.code).toBe(0);
    expect(desk.lifecycle.closes).toBe(1);
    expect(desk.signals.terminated).toEqual([]);
    expect(desk.browser.connected).toEqual(["ws://127.0.0.1:9417/devtools/browser/0b5ad5d6-0000-4000-8000-000000000001"]);
  });

  it("desk quit says pages were not asked about unsaved changes", async () => {
    const desk = setup();

    const result = await desk.run();

    expect(result.message).toContain("Closed the Desk Chrome. Its pages were not asked about unsaved changes (Cmd+Q asks).");
    expect(result.message).toContain("Shells keep running in the terminal daemon; tmux keeps Claude.");
  });

  it("desk quit writes run/quit.marker before it closes Chrome, so desk watch does not relaunch it", async () => {
    const desk = setup();
    desk.lifecycle.onClose = () => {
      desk.log.push(`marker=${desk.files.files.has(`${deskHome}/run/quit.marker`)}`);
      desk.devTools.answering = false;
    };

    await desk.run();

    expect(desk.log).toContain("marker=true");
    expect(desk.files.files.get(`${deskHome}/run/quit.marker`)?.mode).toBe(0o600);
  });

  it("desk quit waits for the port to close after Browser.close", async () => {
    const desk = setup();
    let silentAfter = 3;
    desk.lifecycle.onClose = () => undefined;
    const answer = desk.devTools.version.bind(desk.devTools);
    desk.devTools.version = async (port) => {
      if (desk.lifecycle.closes > 0 && --silentAfter <= 0) desk.devTools.answering = false;
      return answer(port);
    };

    const result = await desk.run();

    expect(result.code).toBe(0);
    expect(desk.clock.sleeps.filter((ms) => ms === 100).length).toBeGreaterThanOrEqual(2);
  });

  it("desk quit exits 75 naming Cmd+Q when the port is still open 10 s after Browser.close", async () => {
    const desk = setup({ closes: false });

    const result = await desk.run();

    expect(result).toEqual({ code: 75, message: "the Desk Chrome did not close within 10 s; quit it with Cmd+Q" });
  });

  it("desk quit exits 75 naming Cmd+Q when the Desk Chrome runs but its debugging port does not answer", async () => {
    const desk = setup({ answers: false });

    const result = await desk.run();

    expect(result).toEqual({ code: 75, message: "the Desk Chrome is running without its debugging port; quit it with Cmd+Q" });
    expect(desk.lifecycle.closes).toBe(0);
  });

  it("desk quit closes nothing when the port answers but no live Desk Chrome holds the profile", async () => {
    const desk = setup({ singleton: false });

    const result = await desk.run();

    expect(result).toEqual({ code: 75, message: "port 9417 is held by another program; desk quit closes only the Desk Chrome" });
    expect(desk.browser.connected).toEqual([]);
  });

  it("desk quit says so and exits 0 when the Desk Chrome is not running", async () => {
    const desk = setup({ answers: false, singleton: false });

    const result = await desk.run();

    expect(result).toEqual({ code: 0, message: "The Desk Chrome is not running." });
    expect(desk.files.files.has(`${deskHome}/run/quit.marker`)).toBe(false);
  });

  it("desk quit leaves the terminal daemon and desk watch running", async () => {
    const desk = setup();

    const result = await desk.run();
    await result.finish?.();

    expect(desk.daemon.notices).toEqual([]);
    expect(desk.signals.terminated).toEqual([]);
  });
});

describe("desk quit --all", () => {
  it("desk quit --all asks on a TTY, stops the daemon and watch, and returns without waiting for its own pane", async () => {
    const desk = setup({ consent: [true] });

    const result = await desk.run(true);

    expect(desk.prompter.asked).toEqual([
      "Quit the Desk Chrome and stop the terminal daemon and desk watch? Plain shells end; tmux sessions keep running.",
    ]);
    expect(result.code).toBe(0);
    expect(desk.signals.terminated).toEqual([5151]);
    expect(desk.daemon.notices).toEqual([]);
    expect(result.finish).toBeDefined();
    await result.finish?.();
    expect(desk.daemon.notices).toEqual([{ type: "shutdown", mode: "stop" }]);
    expect(desk.daemon.requests).toEqual([]);
  });

  it("desk quit --all closes Chrome before it stops desk watch, and stops the daemon last", async () => {
    const desk = setup({ consent: [true] });

    const result = await desk.run(true);
    await result.finish?.();

    expect(desk.log.filter((entry) => /^(lifecycle\.close|signals\.terminate|daemon\.shutdown)/.test(entry))).toEqual([
      "lifecycle.close",
      "signals.terminate 5151",
      "daemon.shutdown stop",
    ]);
  });

  it("desk quit --all names what it stopped", async () => {
    const desk = setup({ consent: [true] });

    const result = await desk.run(true);

    expect(result.message).toContain("Stopped desk watch.");
    expect(result.message).toContain("Stopping the terminal daemon: plain shells end, tmux sessions keep running.");
  });

  it("desk quit --all stops nothing when no desk watch holds its lock, and frees the lock it took", async () => {
    const desk = setup({ consent: [true] });
    desk.lock.heldBy.delete("watch");

    const result = await desk.run(true);

    expect(desk.signals.terminated).toEqual([]);
    expect(desk.lock.released).toEqual(["watch"]);
    expect(result.message).not.toContain("Stopped desk watch.");
  });

  it("desk quit --all says the daemon was not running when nothing listens on its socket", async () => {
    const desk = setup({ consent: [true] });
    desk.daemon.reachable = false;

    const result = await desk.run(true);

    expect(result.message).toContain("The terminal daemon was not running.");
    expect(result.finish).toBeUndefined();
  });

  it("desk quit --all still stops the daemon and watch when the Desk Chrome is not running", async () => {
    const desk = setup({ answers: false, singleton: false, consent: [true] });

    const result = await desk.run(true);
    await result.finish?.();

    expect(result.code).toBe(0);
    expect(desk.signals.terminated).toEqual([5151]);
    expect(desk.daemon.notices).toEqual([{ type: "shutdown", mode: "stop" }]);
  });

  it("desk quit --all changes nothing and exits 77 when declined", async () => {
    const desk = setup({ consent: [false] });

    const result = await desk.run(true);

    expect(result).toEqual({ code: 77, message: "Nothing was changed." });
    expect(desk.lifecycle.closes).toBe(0);
    expect(desk.signals.terminated).toEqual([]);
  });

  it("desk quit --all refuses without an interactive terminal and changes nothing", async () => {
    const desk = setup({ consent: ["no-tty"] });

    const result = await desk.run(true);

    expect(result).toEqual({ code: 64, message: "desk quit --all needs an interactive terminal to ask you first" });
    expect(desk.lifecycle.closes).toBe(0);
  });

  it.each([
    ["confirmed", [true] as const, 0],
    ["declined", [false] as const, 77],
    ["without a terminal", ["no-tty"] as const, 64],
  ])("desk quit --all writes one audit line with its exit code when %s, and plain desk quit writes none", async (_, consent, exit) => {
    const desk = setup({ consent: [...consent] });
    const plain = setup();

    await desk.run(true);
    await plain.run(false);

    expect(desk.audit.events).toEqual([{ event: "consent", operation: "quit-all", exit }]);
    expect(plain.audit.events).toEqual([]);
  });
});
