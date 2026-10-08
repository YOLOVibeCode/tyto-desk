import { mkdtemp } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Daemon, type PaneShell } from "@desk/core";
import { FakeClock, FakeProcessCwd, FakePtySpawner, FakeTerminalMirror, MemoryLayoutStore, MemoryLogSink } from "@desk/core/testing";
import { UnixMessageServer } from "@desk/ptyd";
import { DaemonExtensionBridge, UnixDaemonClient } from "../src/index.ts";

/** A daemon (core's, with a fake PTY) behind a real Unix socket in a short temp directory. */
async function daemonAt(onShutdown: (mode: "stop" | "restart") => void = () => undefined) {
  const path = join(await mkdtemp(join(tmpdir(), "dc-")), "ptyd.sock");
  const daemon = new Daemon({
    spawner: new FakePtySpawner(),
    clock: new FakeClock(),
    build: "0.3.0",
    shellFor: async (): Promise<PaneShell> => ({ file: "/bin/zsh", args: ["-l"], cwd: "/", env: {}, notice: null }),
    cwds: new FakeProcessCwd(),
    onShutdown,
    layouts: new MemoryLayoutStore(),
    log: new MemoryLogSink(),
    mirror: new FakeTerminalMirror(),
    scrollback: 5000,
  });
  const server = new UnixMessageServer(path);
  await server.listen((peer) => daemon.connect(peer));
  return { path, server };
}

/** A service worker on the socket that answers every extension call with `value`. */
async function worker(path: string, value: unknown): Promise<() => void> {
  const socket = connect({ path });
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(`${JSON.stringify({ type: "hello", vMin: 1, vMax: 1, client: "sw", build: "0.3.0" })}\n`);
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, newline)) as { type: string; id: string };
      buffer = buffer.slice(newline + 1);
      if (message.type === "ext.call") socket.write(`${JSON.stringify({ type: "ext.result", id: message.id, ok: true, value })}\n`);
    }
  });
  return () => socket.destroy();
}

describe("the CLI's daemon client", () => {
  it("the daemon client says hello as cli and reads the daemon's pane list", async () => {
    const { path, server } = await daemonAt();

    const opened = await new UnixDaemonClient(path, "0.3.0").open("cli");
    if (!opened.ok) throw new Error(`no session: ${opened.reason}`);
    const reply = await opened.session.request({ type: "list" });
    opened.session.close();

    expect(reply).toMatchObject({ type: "panes", panes: [], panels: [], sw: { connected: false, connects: 0 } });
    await server.close();
  });

  it("the daemon client sends shutdown without waiting for an answer", async () => {
    const stopped: string[] = [];
    const { path, server } = await daemonAt((mode) => stopped.push(mode));

    const opened = await new UnixDaemonClient(path, "0.3.0").open("cli");
    if (!opened.ok) throw new Error(`no session: ${opened.reason}`);
    await opened.session.notify({ type: "shutdown", mode: "stop" });
    opened.session.close();
    for (let i = 0; i < 100 && stopped.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));

    expect(stopped).toEqual(["stop"]);
    await server.close();
  });

  it("the daemon client calls a missing daemon unreachable", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "dc-")), "ptyd.sock");

    expect(await new UnixDaemonClient(path, "0.3.0").open("cli")).toEqual({ ok: false, reason: "unreachable" });
  });

  it("the extension bridge asks the worker for its windows through the daemon", async () => {
    const { path, server } = await daemonAt();
    const windows = [{ id: 7, focused: true, lastFocused: true, panelOpen: false }];
    const stop = await worker(path, windows);
    const client = new UnixDaemonClient(path, "0.3.0");
    for (let i = 0; i < 100; i += 1) {
      const opened = await client.open("cli");
      const listed = opened.ok ? await opened.session.request({ type: "list" }) : null;
      if (opened.ok) opened.session.close();
      if (listed?.type === "panes" && listed.sw.connected) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(await new DaemonExtensionBridge(client).windows()).toEqual(windows);
    stop();
    await server.close();
  });

  it("the extension bridge asks the worker for the active tab's target and the pane's agent tab through the daemon", async () => {
    const { path, server } = await daemonAt();
    const stop = await worker(path, "0123456789ABCDEF0123456789ABCDEF");
    const client = new UnixDaemonClient(path, "0.3.0");
    for (let i = 0; i < 100; i += 1) {
      const opened = await client.open("cli");
      const listed = opened.ok ? await opened.session.request({ type: "list" }) : null;
      if (opened.ok) opened.session.close();
      if (listed?.type === "panes" && listed.sw.connected) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(await new DaemonExtensionBridge(client, "watch").tabCurrent()).toBe("0123456789ABCDEF0123456789ABCDEF");
    expect(await new DaemonExtensionBridge(client).tabMine("p_k2m9q3x7ab")).toBe("0123456789ABCDEF0123456789ABCDEF");
    stop();
    await server.close();
  });

  it("the extension bridge names no tab when no worker answers", async () => {
    const { path, server } = await daemonAt();

    expect(await new DaemonExtensionBridge(new UnixDaemonClient(path, "0.3.0")).tabCurrent()).toBeNull();
    await server.close();
  });

  it("the extension bridge reports no windows when no worker answers", async () => {
    const { path, server } = await daemonAt();

    expect(await new DaemonExtensionBridge(new UnixDaemonClient(path, "0.3.0")).windows()).toBeNull();
    await server.close();
  });

  it("the extension bridge drops a worker's answer that is not a list of windows", async () => {
    const { path, server } = await daemonAt();
    const stop = await worker(path, [{ id: "seven" }]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await new DaemonExtensionBridge(new UnixDaemonClient(path, "0.3.0")).windows()).toBeNull();
    stop();
    await server.close();
  });
});
