import { describe, expect, it } from "vitest";
import { Daemon, WIRE_MESSAGE_MAX, type DaemonMessage, type Layout, type PaneShell } from "../src/index.ts";
import { FakeClock, FakeProcessCwd, FakePtySpawner, FakeTerminalMirror, MemoryLayoutStore, MemoryLogSink } from "../src/testing/index.ts";

const PANE = "p_k2m9q3x7ab";
const OTHER = "p_m9x1d4f6hz";

/** A connection to the daemon that keeps what the daemon sent it. */
type Peer = {
  sent: DaemonMessage[];
  closed: boolean;
  send(line: object): void;
  sendRaw(line: string): void;
  refuse(size: number): void;
  hangUp(): void;
  last(): DaemonMessage | undefined;
};

function setup(options: { notice?: string | null; layouts?: MemoryLayoutStore } = {}) {
  const spawner = new FakePtySpawner();
  const mirror = new FakeTerminalMirror();
  const layouts = options.layouts ?? new MemoryLayoutStore();
  const log = new MemoryLogSink();
  const clock = new FakeClock();
  const shutdowns: string[] = [];
  const shells: string[] = [];
  const cwds = new FakeProcessCwd();
  const daemon = new Daemon({
    spawner,
    clock,
    build: "0.3.0",
    cwds,
    shellFor: async (pane, cwd): Promise<PaneShell> => {
      shells.push(pane);
      return {
        file: "/bin/zsh",
        args: ["-l"],
        cwd: cwd ?? "/Users/alex",
        env: { HOME: "/Users/alex", DESK_PANE: pane },
        notice: options.notice ?? null,
      };
    },
    onShutdown: (mode) => shutdowns.push(mode),
    layouts,
    log,
    mirror,
    scrollback: 5000,
  });
  const connect = (): Peer => {
    const sent: DaemonMessage[] = [];
    const peer = {
      sent,
      closed: false,
      send: (line: object) => connection.receive(JSON.stringify(line)),
      sendRaw: (line: string) => connection.receive(line),
      refuse: (size: number) => connection.refused(size),
      hangUp: () => connection.closed(),
      last: () => sent.at(-1),
    };
    const connection = daemon.connect({
      send: (message) => sent.push(message),
      close: () => {
        peer.closed = true;
      },
    });
    return peer;
  };
  /** A client that said hello as `client`. */
  const client = async (kind: string, extra: object = {}): Promise<Peer> => {
    const peer = connect();
    peer.send({ type: "hello", vMin: 1, vMax: 1, client: kind, build: "0.3.0", ...extra });
    await settle();
    return peer;
  };
  return { daemon, spawner, mirror, clock, shutdowns, shells, layouts, log, connect, client, cwds };
}

/** Lets the daemon's pending promises run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe("the terminal daemon", () => {
  it("the daemon answers hello with the highest protocol version both sides support and its live panes", async () => {
    const { connect } = setup();
    const peer = connect();

    peer.send({ type: "hello", vMin: 1, vMax: 3, client: "panel", build: "0.4.0", window: 7 });
    await settle();

    expect(peer.sent).toEqual([{ type: "hello", v: 1, build: "0.3.0", panes: [], notices: [], layout: { version: 1, activeTab: null, ui: {}, tabs: [] } }]);
  });

  it("a panel's hello carries the saved layout, so the panel needs no second round trip", async () => {
    const saved: Layout = { version: 1, activeTab: "t_0000000001", ui: { fontSize: 14 }, tabs: [{ id: "t_0000000001", focus: PANE, zoomed: null, root: { pane: PANE } }] };
    const layouts = new MemoryLayoutStore({ layout: saved, recovered: false });
    const { client } = setup({ layouts });

    const panel = await client("panel", { window: 7 });
    const cli = await client("cli");

    expect(panel.sent[0]).toMatchObject({ type: "hello", layout: saved });
    expect(cli.sent[0]).not.toHaveProperty("layout");
  });

  it("open with cwdFrom starts the new shell in the directory of that pane's shell, read from its process", async () => {
    const { spawner, client, cwds } = setup();
    const panel = await client("panel", { window: 7 });
    panel.send({ type: "open", id: "r1", pane: PANE, cols: 100, rows: 30 });
    await settle();
    cwds.cwds.set(spawner.spawned[0]?.pty.pid ?? -1, "/Users/alex/Dev/tyto-desk");

    panel.send({ type: "open", id: "r2", pane: OTHER, cols: 100, rows: 30, cwdFrom: PANE });
    await settle();

    expect(spawner.spawned[1]?.options.cwd).toBe("/Users/alex/Dev/tyto-desk");
  });

  it("open with cwdFrom naming a pane that has no shell starts in the default directory", async () => {
    const { spawner, client } = setup();
    const panel = await client("panel", { window: 7 });

    panel.send({ type: "open", id: "r1", pane: OTHER, cols: 100, rows: 30, cwdFrom: PANE });
    await settle();

    expect(spawner.spawned[0]?.options.cwd).toBe("/Users/alex");
  });

  it("hello with no common version gets E_STALE and the daemon keeps running", async () => {
    const { connect, client } = setup();
    const stale = connect();

    stale.send({ type: "hello", vMin: 2, vMax: 3, client: "panel", build: "0.9.0" });
    const fresh = await client("cli");

    expect(stale.last()).toMatchObject({ type: "error", code: "E_STALE" });
    expect(fresh.last()).toMatchObject({ type: "hello", v: 1 });
  });

  it("open starts the pane's login shell at the panel's size and makes the panel its owner", async () => {
    const { spawner, client } = setup();
    const panel = await client("panel", { window: 7 });

    panel.send({ type: "open", id: "r1", pane: PANE, cols: 100, rows: 30 });
    await settle();

    expect(spawner.spawned.map((s) => s.options)).toEqual([
      { file: "/bin/zsh", args: ["-l"], cwd: "/Users/alex", env: { HOME: "/Users/alex", DESK_PANE: PANE }, cols: 100, rows: 30 },
    ]);
    expect(panel.last()).toEqual({ type: "snapshot", pane: PANE, part: 0, last: true, cols: 100, rows: 30, data: '<screen "">' });
  });

  it("the owner's input reaches the shell and the shell's output reaches only the owner", async () => {
    const { spawner, client } = setup();
    const panel = await client("panel", { window: 7 });
    const other = await client("panel", { window: 8 });
    panel.send({ type: "open", id: "r1", pane: PANE, cols: 100, rows: 30 });
    await settle();

    panel.send({ type: "in", pane: PANE, data: "echo desk-ok\r" });
    spawner.pty().print("desk-ok\r\n");

    expect(spawner.pty().written).toEqual(["echo desk-ok\r"]);
    expect(panel.last()).toEqual({ type: "out", pane: PANE, data: "desk-ok\r\n" });
    expect(other.sent.filter((m) => m.type === "out")).toEqual([]);
  });

  it("input and resizes from a client that does not own the pane get E_NOPANE", async () => {
    const { spawner, client } = setup();
    const owner = await client("panel", { window: 7 });
    const other = await client("panel", { window: 8 });
    owner.send({ type: "open", id: "r1", pane: PANE, cols: 100, rows: 30 });
    await settle();

    other.send({ type: "in", pane: PANE, data: "rm -rf ~\r" });
    other.send({ type: "resize", pane: PANE, cols: 20, rows: 5 });
    other.send({ type: "in", pane: OTHER, data: "x" });

    expect(spawner.pty().written).toEqual([]);
    expect(spawner.pty().sizes).toEqual([]);
    expect(other.sent.filter((m) => m.type === "error")).toEqual([
      { type: "error", pane: PANE, code: "E_NOPANE", message: "no such pane, or not its owner" },
      { type: "error", pane: PANE, code: "E_NOPANE", message: "no such pane, or not its owner" },
      { type: "error", pane: OTHER, code: "E_NOPANE", message: "no such pane, or not its owner" },
    ]);
  });

  it("only the owner's resize changes the PTY size", async () => {
    const { spawner, client } = setup();
    const panel = await client("panel", { window: 7 });
    panel.send({ type: "open", id: "r1", pane: PANE, cols: 100, rows: 30 });
    await settle();

    panel.send({ type: "resize", pane: PANE, cols: 132, rows: 43 });

    expect(spawner.spawned[0]?.options).toMatchObject({ cols: 100, rows: 30 });
    expect(spawner.pty().sizes).toEqual([[132, 43]]);
  });

  it("a resize that arrives while the pane's shell is starting sets the size it starts at", async () => {
    const { spawner, client } = setup();
    const panel = await client("panel", { window: 7 });

    panel.send({ type: "open", id: "r1", pane: PANE, cols: 100, rows: 30 });
    panel.send({ type: "resize", pane: PANE, cols: 132, rows: 43 });
    await settle();

    expect(spawner.spawned[0]?.options).toMatchObject({ cols: 132, rows: 43 });
    expect(panel.sent.filter((m) => m.type === "error")).toEqual([]);
  });

  it("open from another panel takes the pane and tells the previous owner it was taken", async () => {
    const { spawner, client } = setup();
    const first = await client("panel", { window: 7 });
    const second = await client("panel", { window: 8 });
    first.send({ type: "open", id: "r1", pane: PANE, cols: 100, rows: 30 });
    await settle();

    second.send({ type: "open", id: "r2", pane: PANE, cols: 80, rows: 24 });
    await settle();
    spawner.pty().print("after\r\n");

    expect(spawner.spawned).toHaveLength(1);
    expect(first.sent).toContainEqual({ type: "detached", pane: PANE, reason: "taken" });
    expect(second.last()).toEqual({ type: "out", pane: PANE, data: "after\r\n" });
    expect(first.sent.filter((m) => m.type === "out")).toEqual([]);
  });

  it("a pane's shell keeps running when its panel disconnects, and the next open re-attaches it", async () => {
    const { spawner, client } = setup();
    const panel = await client("panel", { window: 7 });
    panel.send({ type: "open", id: "r1", pane: PANE, cols: 100, rows: 30 });
    await settle();

    panel.hangUp();
    spawner.pty().print("nobody sees this\r\n");
    const again = await client("panel", { window: 7 });
    again.send({ type: "open", id: "r2", pane: PANE, cols: 100, rows: 30 });
    await settle();

    expect(spawner.pty().signals).toEqual([]);
    expect(spawner.spawned).toHaveLength(1);
    expect(again.sent[0]).toMatchObject({ type: "hello", v: 1, build: "0.3.0", panes: [{ id: PANE, alive: true }], notices: [] });
    // The mirror kept what the shell printed while no panel owned it (slice 2b).
    expect(again.last()).toMatchObject({ type: "snapshot", pane: PANE, data: '<screen "nobody sees this\\r\\n">' });
  });

  it("a shell that exits is reported to its owner, and the next open of that pane starts a new one", async () => {
    const { spawner, client } = setup();
    const panel = await client("panel", { window: 7 });
    panel.send({ type: "open", id: "r1", pane: PANE, cols: 100, rows: 30 });
    await settle();

    spawner.pty().end({ code: 0, signal: null });
    panel.send({ type: "open", id: "r2", pane: PANE, cols: 100, rows: 30 });
    await settle();

    expect(panel.sent).toContainEqual({ type: "exit", pane: PANE, code: 0, signal: null });
    expect(spawner.spawned).toHaveLength(2);
  });

  it("exited panes no panel owns are dropped when a new pane opens, so shells that exit never fill the daemon's 64 panes", async () => {
    const { spawner, client } = setup();
    for (let i = 0; i < 64; i += 1) {
      const panel = await client("panel", { window: 7 });
      panel.send({ type: "open", id: `r${i}`, pane: `p_${String(i).padStart(10, "0")}`, cols: 100, rows: 30 });
      await settle();
      spawner.pty(i).end({ code: 0, signal: null });
      panel.hangUp();
    }
    const panel = await client("panel", { window: 7 });

    panel.send({ type: "open", id: "r64", pane: PANE, cols: 100, rows: 30 });
    await settle();
    panel.send({ type: "list", id: "l1" });

    expect(spawner.spawned).toHaveLength(65);
    expect(panel.sent).toContainEqual(expect.objectContaining({ type: "snapshot", pane: PANE }));
    expect(panel.last()).toMatchObject({ type: "panes", panes: [{ id: PANE, alive: true, owned: true }] });
  });

  it("a pane whose shell exited stays listed as exited until the next open", async () => {
    const { spawner, client } = setup();
    const panel = await client("panel", { window: 7 });
    panel.send({ type: "open", id: "r1", pane: PANE, cols: 100, rows: 30 });
    await settle();
    spawner.pty().end({ code: 0, signal: null });
    panel.hangUp();
    const cli = await client("cli");

    cli.send({ type: "list", id: "l1" });

    expect(cli.last()).toMatchObject({ type: "panes", panes: [{ id: PANE, alive: false, owned: false }] });
  });

  it("a shell that cannot start gets E_SPAWN", async () => {
    const { spawner, client } = setup();
    spawner.failing = true;
    const panel = await client("panel", { window: 7 });

    panel.send({ type: "open", id: "r1", pane: PANE, cols: 100, rows: 30 });
    await settle();

    expect(panel.last()).toEqual({ type: "error", id: "r1", pane: PANE, code: "E_SPAWN", message: "the shell could not start" });
  });

  it("the shell plan's notice reaches the panel that opened the pane", async () => {
    const { client } = setup({ notice: "tmux-line-missing" });
    const panel = await client("panel", { window: 7 });

    panel.send({ type: "open", id: "r1", pane: PANE, cols: 100, rows: 30 });
    await settle();

    expect(panel.sent).toContainEqual({ type: "notice", kind: "tmux-line-missing" });
  });

  it("the shell's output is split into messages of at most 768 KiB encoded", async () => {
    const { spawner, client } = setup();
    const panel = await client("panel", { window: 7 });
    panel.send({ type: "open", id: "r1", pane: PANE, cols: 100, rows: 30 });
    await settle();
    const output = "\u001b[0m".repeat(200_000);

    spawner.pty().print(output);
    const outs = panel.sent.filter((m) => m.type === "out");

    expect(outs.length).toBeGreaterThan(1);
    expect(outs.map((m) => (m.type === "out" ? m.data : "")).join("")).toBe(output);
    for (const message of outs) expect(new TextEncoder().encode(JSON.stringify(message)).length).toBeLessThanOrEqual(WIRE_MESSAGE_MAX);
  });

  it("list reports the panes, the windows whose panel said hello, and the service worker's connection", async () => {
    const { client } = setup();
    const panel = await client("panel", { window: 7 });
    panel.send({ type: "open", id: "r1", pane: PANE, cols: 100, rows: 30 });
    await settle();
    await client("sw");
    const cli = await client("cli");

    cli.send({ type: "list", id: "r9" });

    expect(cli.last()).toEqual({
      type: "panes",
      id: "r9",
      panes: [{ id: PANE, alive: true, owned: true }],
      panels: [{ window: 7 }],
      sw: { connected: true, connects: 1 },
      gatewayClients: 0,
      paused: false,
    });
  });

  it("the daemon relays an extension call from the launcher to the service worker and its answer back", async () => {
    const { client } = setup();
    const sw = await client("sw");
    const cli = await client("cli");

    cli.send({ type: "ext.call", id: "r5", op: "windows" });
    const relayed = sw.last();
    if (relayed?.type !== "ext.call") throw new Error("the worker got no call");
    sw.send({ type: "ext.result", id: relayed.id, ok: true, value: [{ id: 7, focused: true, lastFocused: true, panelOpen: false }] });

    expect(relayed).toEqual({ type: "ext.call", id: expect.stringMatching(/^x\d+$/), op: "windows" });
    expect(cli.last()).toEqual({
      type: "ext.result",
      id: "r5",
      ok: true,
      value: [{ id: 7, focused: true, lastFocused: true, panelOpen: false }],
    });
  });

  it("an extension call with no service worker connected gets E_NOEXT", async () => {
    const { client } = setup();
    const cli = await client("cli");

    cli.send({ type: "ext.call", id: "r5", op: "windows" });

    expect(cli.last()).toEqual({ type: "error", id: "r5", code: "E_NOEXT", message: "the Desk extension is not connected" });
  });

  it("an extension call the service worker does not answer within 2 s gets E_NOEXT", async () => {
    const { clock, client } = setup();
    await client("sw");
    const cli = await client("cli");

    cli.send({ type: "ext.call", id: "r5", op: "windows" });
    await clock.advance(1_999);
    const early = cli.sent.length;
    await clock.advance(1);

    expect(early).toBe(1);
    expect(cli.last()).toEqual({ type: "error", id: "r5", code: "E_NOEXT", message: "the Desk extension is not connected" });
  });

  it("an extension call is answered with E_NOEXT when the service worker disconnects first", async () => {
    const { client } = setup();
    const sw = await client("sw");
    const cli = await client("cli");

    cli.send({ type: "ext.call", id: "r5", op: "windows" });
    sw.hangUp();
    cli.send({ type: "list", id: "r6" });

    expect(cli.sent.at(-2)).toEqual({ type: "error", id: "r5", code: "E_NOEXT", message: "the Desk extension is not connected" });
    expect(cli.last()).toMatchObject({ type: "panes", sw: { connected: false, connects: 1 } });
  });

  it("a malformed line gets E_PROTO and the daemon keeps serving", async () => {
    const { daemon, client } = setup();
    const sent: DaemonMessage[] = [];
    const connection = daemon.connect({ send: (m) => sent.push(m), close: () => undefined });

    connection.receive("{ not json");
    const cli = await client("cli");

    expect(sent).toEqual([{ type: "error", code: "E_PROTO", message: "the message was malformed" }]);
    expect(cli.last()).toMatchObject({ type: "hello" });
  });

  it("a client must say hello before anything else", async () => {
    const { connect } = setup();
    const peer = connect();

    peer.send({ type: "list", id: "r1" });

    expect(peer.last()).toEqual({ type: "error", id: "r1", code: "E_PROTO", message: "the message was malformed" });
  });

  it.each([
    ["sw", { type: "open", id: "r1", pane: PANE, cols: 80, rows: 24 }],
    ["sw", { type: "ext.call", id: "r1", op: "windows" }],
    ["cli", { type: "in", pane: PANE, data: "x" }],
    ["cli", { type: "ext.result", id: "x1", ok: true }],
    ["panel", { type: "ext.call", id: "r1", op: "windows" }],
    ["watch", { type: "open", id: "r1", pane: PANE, cols: 80, rows: 24 }],
    ["sw", { type: "layout.get", id: "r1" }],
    ["sw", { type: "close", id: "r1", pane: PANE }],
    ["cli", { type: "layout.put", id: "r1", layout: { version: 1, activeTab: null, ui: {}, tabs: [] } }],
    ["cli", { type: "close", id: "r1", pane: PANE }],
    ["cli", { type: "alert", kind: "terminal-attached" }],
    ["cli", { type: "gateway.state", clients: 1 }],
    ["panel", { type: "agents.state", paused: true }],
    ["panel", { type: "alert", kind: "terminal-attached" }],
    ["panel", { type: "gateway.state", clients: 1 }],
    ["watch", { type: "layout.put", id: "r1", layout: { version: 1, activeTab: null, ui: {}, tabs: [] } }],
    ["watch", { type: "shutdown", mode: "stop" }],
    ["watch", { type: "agents.state", paused: true }],
  ])("a %s client sending %j gets E_VERB", async (kind, message) => {
    const { client } = setup();
    const peer = await client(kind);

    peer.send(message);

    expect(peer.last()).toMatchObject({ type: "error", code: "E_VERB" });
  });

  it("shutdown sends SIGHUP to every running shell and ends the daemon", async () => {
    const { spawner, shutdowns, client } = setup();
    const panel = await client("panel", { window: 7 });
    panel.send({ type: "open", id: "r1", pane: PANE, cols: 100, rows: 30 });
    panel.send({ type: "open", id: "r2", pane: OTHER, cols: 100, rows: 30 });
    await settle();
    spawner.pty(1).end({ code: 0, signal: null });
    const cli = await client("cli");

    cli.send({ type: "shutdown", mode: "stop" });

    expect(spawner.pty(0).signals).toEqual(["SIGHUP"]);
    expect(spawner.pty(1).signals).toEqual([]);
    expect(shutdowns).toEqual(["stop"]);
  });

  it("stop, from the daemon's SIGTERM or SIGHUP, ends it as shutdown does: SIGHUP to every running shell, every client closed", async () => {
    const { daemon, spawner, shutdowns, client } = setup();
    const panel = await client("panel", { window: 7 });
    panel.send({ type: "open", id: "r1", pane: PANE, cols: 100, rows: 30 });
    await settle();

    daemon.stop();
    daemon.stop();

    expect(spawner.pty().signals).toEqual(["SIGHUP"]);
    expect(panel.closed).toBe(true);
    expect(shutdowns).toEqual(["stop"]);
  });

  it("shutdown is accepted after E_STALE", async () => {
    const { shutdowns, connect } = setup();
    const stale = connect();
    stale.send({ type: "hello", vMin: 2, vMax: 2, client: "panel", build: "0.9.0" });

    stale.send({ type: "shutdown", mode: "restart" });

    expect(shutdowns).toEqual(["restart"]);
  });

});

const TAB = "t_k2m9q3x7ab";
const layoutWith = (pane: string): Layout => ({
  version: 1,
  activeTab: TAB,
  ui: { fontSize: 13 },
  tabs: [{ id: TAB, focus: pane, zoomed: null, root: { pane } }],
});

describe("the terminal daemon's protocol and lifecycle (slice 2a)", () => {
  it("replies and errors echo the request id, and pane errors name the pane", async () => {
    const { client } = setup();
    const panel = await client("panel", { window: 7 });

    panel.send({ type: "list", id: "r-list" });
    const listed = panel.last();
    panel.send({ type: "layout.get", id: "r-layout" });
    await settle();
    const layout = panel.last();
    panel.send({ type: "close", id: "r-close", pane: PANE });
    const closeError = panel.last();
    panel.send({ type: "in", pane: OTHER, data: "x" });
    const inError = panel.last();

    expect(listed).toMatchObject({ type: "panes", id: "r-list" });
    expect(layout).toMatchObject({ type: "layout", id: "r-layout" });
    expect(closeError).toEqual({ type: "error", id: "r-close", pane: PANE, code: "E_NOPANE", message: "no such pane, or not its owner" });
    expect(inError).toEqual({ type: "error", pane: OTHER, code: "E_NOPANE", message: "no such pane, or not its owner" });
  });

  it("a line over 1 MiB gets E_PROTO and only its size is logged", async () => {
    const { client, log } = setup();
    const panel = await client("panel", { window: 7 });

    panel.refuse(1_048_577);

    expect(panel.last()).toEqual({ type: "error", code: "E_PROTO", message: "the message was malformed" });
    expect(log.events).toEqual([{ event: "line-refused", size: 1_048_577 }]);
  });

  it("a malformed line's content never reaches a log, even through a parser error message", async () => {
    const { client, log } = setup();
    const panel = await client("panel", { window: 7 });

    const truncated = '{"type":"in","pane":"desk-canary-7f3e","data":';
    const unknownShape = '{"type":"open","id":"desk-canary-7f3e"}';
    panel.sendRaw(truncated);
    panel.sendRaw(unknownShape);

    expect(log.events).toEqual([
      { event: "bad-line", size: truncated.length },
      { event: "bad-line", size: unknownShape.length },
    ]);
    expect(JSON.stringify(log.events)).not.toContain("canary");
  });

  it("layout.put saves the layout and broadcasts it to every panel", async () => {
    const { client, layouts } = setup();
    const first = await client("panel", { window: 7 });
    const second = await client("panel", { window: 8 });
    first.send({ type: "open", id: "r1", pane: PANE, cols: 80, rows: 24 });
    await settle();

    first.send({ type: "layout.put", id: "r2", layout: layoutWith(PANE) });
    await settle();

    expect(layouts.saved).toEqual([layoutWith(PANE)]);
    expect(first.sent).toContainEqual({ type: "layout", layout: layoutWith(PANE) });
    expect(second.last()).toEqual({ type: "layout", layout: layoutWith(PANE) });
  });

  it("layout.get answers with the saved layout", async () => {
    const layouts = new MemoryLayoutStore({ layout: layoutWith(PANE), recovered: false });
    const { client } = setup({ layouts });
    const panel = await client("panel", { window: 7 });
    panel.send({ type: "open", id: "r1", pane: PANE, cols: 80, rows: 24 });
    await settle();

    panel.send({ type: "layout.get", id: "r2" });
    await settle();

    expect(panel.last()).toEqual({ type: "layout", id: "r2", layout: layoutWith(PANE) });
  });

  it.each([
    ["over 64 KiB", () => ({ ...layoutWith(PANE), ui: { fontSize: 13, filler: "x".repeat(70_000) } })],
    [
      "deeper than 16",
      () => {
        let root: object = { pane: PANE };
        for (let i = 0; i < 17; i += 1) root = { split: "row", ratio: 0.5, a: root, b: { pane: PANE } };
        return { ...layoutWith(PANE), tabs: [{ id: TAB, focus: PANE, zoomed: null, root }] };
      },
    ],
    ["naming an unknown pane", () => layoutWith(OTHER)],
  ])("layout.put %s gets E_LIMIT", async (_, layout) => {
    const { client, layouts } = setup();
    const panel = await client("panel", { window: 7 });
    panel.send({ type: "open", id: "r1", pane: PANE, cols: 80, rows: 24 });
    await settle();

    panel.send({ type: "layout.put", id: "r2", layout: layout() });
    await settle();

    expect(panel.last()).toEqual({ type: "error", id: "r2", code: "E_LIMIT", message: "over a protocol limit" });
    expect(layouts.saved).toEqual([]);
  });

  it("a corrupt or newer state file is moved aside and the daemon continues with its live panes", async () => {
    const layouts = new MemoryLayoutStore({ layout: null, recovered: true });
    const { client, log } = setup({ layouts });
    const panel = await client("panel", { window: 7 });
    panel.send({ type: "open", id: "r1", pane: PANE, cols: 80, rows: 24 });
    await settle();

    panel.send({ type: "layout.get", id: "r2" });
    await settle();
    const answer = panel.last();

    expect(log.events).toContainEqual({ event: "state-recovered", file: "layout" });
    expect(answer).toMatchObject({ type: "layout", id: "r2" });
    expect(JSON.stringify(answer)).toContain(PANE);
  });

  it("alerts from desk watch and the agents' state from desk reach every panel, and list reports them", async () => {
    const { client } = setup();
    const panel = await client("panel", { window: 7 });
    const watch = await client("watch");
    const cli = await client("cli");

    watch.send({ type: "alert", kind: "terminal-attached" });
    const alert = panel.last();
    watch.send({ type: "gateway.state", clients: 2 });
    cli.send({ type: "agents.state", paused: true });
    const paused = panel.last();
    cli.send({ type: "list", id: "r1" });

    expect(alert).toEqual({ type: "alert", kind: "terminal-attached" });
    expect(paused).toEqual({ type: "notice", kind: "agents-paused" });
    expect(cli.last()).toMatchObject({ type: "panes", id: "r1", gatewayClients: 2, paused: true });
  });

  it("close ends the pane's shell with SIGHUP and answers closed", async () => {
    const { client, spawner } = setup();
    const panel = await client("panel", { window: 7 });
    panel.send({ type: "open", id: "r1", pane: PANE, cols: 80, rows: 24 });
    await settle();

    panel.send({ type: "close", id: "r2", pane: PANE });
    panel.send({ type: "list", id: "r3" });

    expect(spawner.pty().signals).toEqual(["SIGHUP"]);
    expect(panel.sent).toContainEqual({ type: "closed", pane: PANE });
    expect(panel.last()).toMatchObject({ type: "panes", panes: [] });
  });

  it("detach lets go of the pane, whose shell keeps running", async () => {
    const { client, spawner } = setup();
    const panel = await client("panel", { window: 7 });
    panel.send({ type: "open", id: "r1", pane: PANE, cols: 80, rows: 24 });
    await settle();

    panel.send({ type: "detach", pane: PANE });
    panel.send({ type: "list", id: "r2" });

    expect(spawner.pty().signals).toEqual([]);
    expect(panel.last()).toMatchObject({ type: "panes", panes: [{ id: PANE, alive: true, owned: false }] });
  });
});

describe("the terminal daemon's output, attach and flow control (slice 2b)", () => {
  /** A panel in window 7 that opened PANE at 100×30, its shell started and its first snapshot taken. */
  async function opened() {
    const desk = setup();
    const panel = await desk.client("panel", { window: 7 });
    panel.send({ type: "open", id: "r1", pane: PANE, cols: 100, rows: 30 });
    await settle();
    return { ...desk, panel, pty: desk.spawner.pty(), screen: desk.mirror.screen() };
  }

  const outs = (sent: DaemonMessage[]) => sent.filter((m) => m.type === "out").map((m) => (m.type === "out" ? m.data : ""));
  const snapshots = (sent: DaemonMessage[]) => sent.filter((m) => m.type === "snapshot").map((m) => (m.type === "snapshot" ? m.data : ""));

  it("output produced while a pane is being opened appears exactly once, after its snapshot", async () => {
    const { pty, screen, client, clock } = await opened();
    pty.print("A");
    await clock.advance(10);
    const second = await client("panel", { window: 8 });
    screen.holding = true;

    second.send({ type: "open", id: "r2", pane: PANE, cols: 100, rows: 30 });
    await settle();
    pty.print("B");
    screen.release();
    await settle();
    await clock.advance(10);

    const types = second.sent.map((m) => m.type).filter((t) => t === "snapshot" || t === "out");
    expect(types).toEqual(["snapshot", "out"]);
    expect(snapshots(second.sent).join("")).toContain('"A"');
    expect(snapshots(second.sent).join("")).not.toContain("B");
    expect(outs(second.sent)).toEqual(["B"]);
  });

  it("a snapshot ends with the unfinished escape sequence at the flush point", async () => {
    const { pty, client, clock } = await opened();
    pty.print("x\u001b[3");
    await clock.advance(10);
    const second = await client("panel", { window: 8 });

    second.send({ type: "open", id: "r2", pane: PANE, cols: 100, rows: 30 });
    await settle();

    expect(snapshots(second.sent).join("")).toMatch(/\u001b\[3$/);
  });

  it("the daemon's snapshot replays the modes serialize does not write, before the unfinished escape", async () => {
    const { pty, client, clock } = await opened();
    pty.print("\u001b[?1006h\u001b[?25l\u001b[4 qok\u001b]0;ti");
    await clock.advance(10);
    const second = await client("panel", { window: 8 });

    second.send({ type: "open", id: "r2", pane: PANE, cols: 100, rows: 30 });
    await settle();

    expect(snapshots(second.sent).join("")).toMatch(/\u001b\[\?1006h\u001b\[\?25l\u001b\[4 q\u001b\]0;ti$/);
  });

  it("re-attaching a pane in the alternate screen resizes it to rows-1 and back", async () => {
    const { pty, screen, client } = await opened();
    screen.altScreen = true;
    const sizesBefore = pty.sizes.length;
    const second = await client("panel", { window: 8 });

    second.send({ type: "open", id: "r2", pane: PANE, cols: 100, rows: 30 });
    await settle();

    expect(pty.sizes.slice(sizesBefore)).toEqual([
      [100, 29],
      [100, 30],
    ]);
  });

  it("re-attaching a plain shell never resizes it", async () => {
    const { pty, client } = await opened();
    const sizesBefore = pty.sizes.length;
    const second = await client("panel", { window: 8 });

    second.send({ type: "open", id: "r2", pane: PANE, cols: 100, rows: 30 });
    await settle();

    expect(pty.sizes.slice(sizesBefore)).toEqual([]);
  });

  it("the first output after 4 ms of quiet is sent at once", async () => {
    const { pty, panel, clock } = await opened();
    await clock.advance(5);

    pty.print("hello");

    expect(outs(panel.sent)).toEqual(["hello"]);
  });

  it("bursts are coalesced into messages of at most 65,536 characters", async () => {
    const { pty, panel, clock } = await opened();
    await clock.advance(5);
    pty.print("a");
    const chunk = "b".repeat(10_000);

    for (let i = 0; i < 15; i += 1) pty.print(chunk);
    await clock.advance(4);

    const sent = outs(panel.sent);
    expect(sent[0]).toBe("a");
    expect(sent.slice(1).every((data) => data.length <= 65_536)).toBe(true);
    expect(sent.slice(1).length).toBe(3);
    expect(sent.join("")).toBe(`a${chunk.repeat(15)}`);
  });

  it("the PTY pauses above 100,000 unacknowledged characters and resumes below 5,000", async () => {
    const { pty, panel, clock } = await opened();
    await clock.advance(5);

    pty.print("x".repeat(100_001));
    await clock.advance(4);
    const paused = pty.paused;
    panel.send({ type: "ack", pane: PANE, n: 96_000 });

    expect(paused).toBe(true);
    expect(pty.paused).toBe(false);
  });

  it("an owner over the limit for 10 s is detached as stuck and the pane resumes", async () => {
    const { pty, panel, clock } = await opened();
    await clock.advance(5);

    pty.print("x".repeat(150_000));
    await clock.advance(10_004);

    expect(panel.sent).toContainEqual({ type: "detached", pane: PANE, reason: "stuck" });
    expect(pty.paused).toBe(false);
  });

  it("opening an exited pane again gives its new shell a new mirror and disposes the old one", async () => {
    const { pty, panel, mirror } = await opened();
    pty.end({ code: 0, signal: null });
    await settle();

    panel.send({ type: "open", id: "r2", pane: PANE, cols: 100, rows: 30 });
    await settle();

    expect(mirror.screens.map((screen) => screen.disposed)).toEqual([true, false]);
  });

  it("the PTY pauses while its mirror is more than 1,000,000 characters behind, and resumes once the mirror catches up", async () => {
    const { pty, panel, screen, clock } = await opened();
    panel.send({ type: "visibility", state: "hidden" });
    await clock.advance(5);
    screen.holding = true;

    pty.print("x".repeat(600_000));
    const under = pty.paused;
    pty.print("y".repeat(400_001));
    const over = pty.paused;
    screen.release();
    await settle();

    expect([under, over, pty.paused]).toEqual([false, true, false]);
  });

  it("a PTY paused for its owner stays paused while only the mirror catches up", async () => {
    const { pty, screen, clock } = await opened();
    await clock.advance(5);
    screen.holding = true;

    pty.print("x".repeat(1_000_001));
    await clock.advance(4);
    screen.release();
    await settle();

    expect(pty.paused).toBe(true);
  });

  it("a hidden owner receives no output and never pauses the PTY", async () => {
    const { pty, panel, clock } = await opened();
    panel.send({ type: "visibility", state: "hidden" });
    await clock.advance(5);
    const before = outs(panel.sent).length;

    pty.print("x".repeat(200_000));
    await clock.advance(10_004);

    expect(outs(panel.sent).length).toBe(before);
    expect(pty.paused).toBe(false);
    expect(panel.sent).not.toContainEqual({ type: "detached", pane: PANE, reason: "stuck" });
  });

  it("the mirror never writes to the PTY", async () => {
    const { pty, screen, client, clock } = await opened();
    pty.print("\u001b[6n\u001b[c");
    await clock.advance(10);
    const second = await client("panel", { window: 8 });

    second.send({ type: "open", id: "r2", pane: PANE, cols: 100, rows: 30 });
    await settle();

    expect(screen.written).toContain("\u001b[6n");
    expect(pty.written).toEqual([]);
  });

  it("exit reports the code and signal to the owner", async () => {
    const { pty, panel } = await opened();

    pty.end({ code: null, signal: 9 });

    expect(panel.last()).toEqual({ type: "exit", pane: PANE, code: null, signal: 9 });
  });
});
