import { describe, expect, it } from "vitest";
import { daemonRestart, deskStatus, newDeskConfig } from "../src/index.ts";
import {
  FakeChromeProfile,
  FakeDaemonClient,
  FakeDevToolsHttp,
  FakeInstanceLock,
  FakeProcessInfo,
  MemoryConfigStore,
  MemoryLogSink,
  ScriptedPrompter,
} from "../src/testing/index.ts";

const config = newDeskConfig({ home: "/Users/alex", platform: "darwin", chromePort: 9417, gatewayPort: 9583 });

function setup() {
  const daemon = new FakeDaemonClient({ reachable: true });
  daemon.swConnected = true;
  daemon.panels = [7];
  daemon.paneList = [
    { id: "p_k2m9q3x7ab", alive: true, owned: true },
    { id: "p_m9x1d4f6hz", alive: false, owned: false },
  ];
  const lock = new FakeInstanceLock();
  lock.holders.set("watch", { pid: 5151, build: "0.3.1" });
  const ports = {
    config: new MemoryConfigStore(config),
    profileFor: () => new FakeChromeProfile({ lock: { host: "alex-mac", pid: 4242 } }),
    processes: new FakeProcessInfo([4242]),
    devTools: new FakeDevToolsHttp({ answering: true }),
    daemon,
    lock,
  };
  return { ports, daemon, lock };
}

describe("desk status", () => {
  it("desk status lists pane ids with alive or exited and never a title or directory", async () => {
    const { ports } = setup();

    const status = await deskStatus(ports);

    expect(status.code).toBe(0);
    expect(status.message).toContain("Panes:    p_k2m9q3x7ab alive, p_m9x1d4f6hz exited");
    expect(status.message).not.toMatch(/\/Users|~\/|title/i);
  });

  it("desk status names Chrome's pid, ports and version, desk watch, the daemon, the panels and the agents' state", async () => {
    const { ports } = setup();

    const lines = (await deskStatus(ports)).message.split("\n");

    expect(lines).toEqual([
      "Chrome:   running (pid 4242, port 9417, Chrome/155.0.8059.40)",
      "Guarded:  port 9583, served by desk watch (pid 5151, 0.3.1), 0 clients",
      "Daemon:   running; service worker connected",
      "Panels:   window 7",
      "Panes:    p_k2m9q3x7ab alive, p_m9x1d4f6hz exited",
      "Agents:   allowed",
    ]);
  });

  it("desk status says what is not running", async () => {
    const { ports, daemon, lock } = setup();
    ports.devTools.answering = false;
    ports.processes.live.clear();
    daemon.reachable = false;
    lock.holders.clear();

    const lines = (await deskStatus(ports)).message.split("\n");

    expect(lines).toEqual([
      "Chrome:   not running",
      "Guarded:  port 9583, desk watch not running",
      "Daemon:   not running",
    ]);
  });
});

describe("desk daemon restart", () => {
  it("desk daemon restart asks on a TTY, sends shutdown, and exits without waiting for its own pane", async () => {
    const daemon = new FakeDaemonClient({ reachable: true });
    const prompter = new ScriptedPrompter([true]);
    const log = new MemoryLogSink();

    const result = await daemonRestart({ daemon, prompter, log });

    expect(prompter.asked).toEqual(["Restart the terminal daemon? Plain shells end; tmux sessions survive and re-attach."]);
    expect(result).toMatchObject({ code: 0, message: "Restarting the terminal daemon: plain shells end, tmux sessions survive and re-attach." });
    expect(daemon.notices).toEqual([]);
    await result.finish?.();
    expect(daemon.notices).toEqual([{ type: "shutdown", mode: "restart" }]);
    expect(log.events).toEqual([{ event: "consent", operation: "daemon-restart", exit: 0 }]);
  });

  it.each([
    ["no terminal", "no-tty" as const, 64],
    ["a no", false, 77],
  ])("desk daemon restart changes nothing after %s", async (_, answer, code) => {
    const daemon = new FakeDaemonClient({ reachable: true });
    const log = new MemoryLogSink();

    const result = await daemonRestart({ daemon, prompter: new ScriptedPrompter([answer]), log });

    expect(result.code).toBe(code);
    expect(result.finish).toBeUndefined();
    expect(log.events).toEqual([{ event: "consent", operation: "daemon-restart", exit: code }]);
  });

  it("desk daemon restart says so when the daemon is not running", async () => {
    const result = await daemonRestart({ daemon: new FakeDaemonClient({ reachable: false }), prompter: new ScriptedPrompter([true]), log: new MemoryLogSink() });

    expect(result).toEqual({ code: 69, message: "The terminal daemon is not running." });
  });
});
