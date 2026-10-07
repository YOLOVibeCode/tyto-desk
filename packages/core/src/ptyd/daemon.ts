import type { Clock } from "../ports/clock.ts";
import type { Pty, PtyExit, PtySpawner } from "../ports/pty-spawner.ts";
import {
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  errorMessage,
  parseClientMessage,
  type ClientKind,
  type ClientMessage,
  type DaemonMessage,
  type ErrorCode,
  type ExtCall,
  type ExtResult,
  type Open,
} from "../protocol/messages.ts";
import { WIRE_DATA_MAX, splitForWire } from "../protocol/split.ts";

/** How a new pane's shell starts, decided at every spawn (the agent-variable gate runs there), and what to tell its panel. */
export type PaneShell = {
  file: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  notice: string | null;
};

export type DaemonPorts = {
  spawner: PtySpawner;
  clock: Clock;
  /** This daemon's version, for `hello`. */
  build: string;
  shellFor(pane: string): Promise<PaneShell>;
  /** Called once, after a shutdown was accepted and every running shell got SIGHUP. */
  onShutdown(mode: "stop" | "restart"): void;
};

/** One client connection, as the daemon writes to it. */
export interface DaemonPeer {
  send(message: DaemonMessage): void;
  close(): void;
}

/** What the transport tells the daemon about a connection: each line it read, and that it closed. */
export type DaemonConnection = { receive(line: string): void; closed(): void };

/** The panes Desk keeps at most (§7.2). */
const PANES_MAX = 64;

/** How long the daemon waits for the service worker to answer an extension call (§6.6). */
const EXT_CALL_MS = 2_000;

/** What each client kind may send after hello (§7.2's table, the verbs slice 1c implements). */
const VERBS: Readonly<Record<ClientKind, readonly ClientMessage["type"][]>> = {
  panel: ["open", "in", "resize", "list", "shutdown"],
  sw: ["ext.result"],
  cli: ["list", "ext.call", "shutdown"],
  watch: ["list", "ext.call"],
};

type Client = { peer: DaemonPeer; kind: ClientKind | null; window: number | null; stale: boolean };

type Pane = {
  id: string;
  pty: Pty | null;
  owner: Client | null;
  alive: boolean;
  starting: boolean;
  cols: number;
  rows: number;
};

/** An extension call on its way: who asked, under which id, and the worker it went to. */
type PendingCall = { caller: Client; id: string; sw: Client };

/**
 * The terminal daemon's state machine (docs/IMPLEMENTATION.md §7): clients and what they may send, panes and their one
 * owner each, input to the owner's shell and output to the owner only, and the extension calls it relays between the
 * launcher and the service worker. Slice 1c keeps no mirror: a re-attached pane starts from an empty snapshot. It never
 * throws on input; a message it cannot read gets E_PROTO.
 */
export class Daemon {
  private readonly ports: DaemonPorts;
  private readonly clients = new Set<Client>();
  private readonly panes = new Map<string, Pane>();
  private readonly pending = new Map<string, PendingCall>();
  private sw: Client | null = null;
  private swConnects = 0;
  private nextCall = 0;
  private shuttingDown = false;

  constructor(ports: DaemonPorts) {
    this.ports = ports;
  }

  connect(peer: DaemonPeer): DaemonConnection {
    const client: Client = { peer, kind: null, window: null, stale: false };
    this.clients.add(client);
    return {
      receive: (line) => this.receive(client, line),
      closed: () => this.disconnect(client),
    };
  }

  private send(client: Client, message: DaemonMessage): void {
    if (this.clients.has(client)) client.peer.send(message);
  }

  private fail(client: Client, code: ErrorCode, about: { id?: string; pane?: string } = {}): void {
    this.send(client, errorMessage(code, about));
  }

  private receive(client: Client, line: string): void {
    const message = parseClientMessage(line);
    if (message === null) {
      this.fail(client, "E_PROTO");
      return;
    }
    if (message.type === "shutdown") {
      if (client.kind === null || client.kind === "panel" || client.kind === "cli") this.shutdown(message.mode);
      else this.fail(client, "E_VERB");
      return;
    }
    if (message.type === "hello") {
      this.hello(client, message.vMin, message.vMax, message.client, message.window ?? null);
      return;
    }
    const about = "id" in message ? { id: message.id } : {};
    if (client.kind === null || client.stale) {
      this.fail(client, "E_PROTO", about);
      return;
    }
    if (!VERBS[client.kind].includes(message.type)) {
      this.fail(client, "E_VERB", about);
      return;
    }
    switch (message.type) {
      case "open":
        void this.open(client, message);
        return;
      case "in":
        this.owned(client, message.pane)?.write(message.data);
        return;
      case "resize": {
        const pane = this.panes.get(message.pane);
        if (pane !== undefined && pane.starting && pane.owner === client) {
          // The shell starts at the newest size its owner asked for.
          pane.cols = message.cols;
          pane.rows = message.rows;
          return;
        }
        const pty = this.owned(client, message.pane);
        if (pty === null || pane === undefined) return;
        pane.cols = message.cols;
        pane.rows = message.rows;
        pty.resize(message.cols, message.rows);
        return;
      }
      case "list":
        this.send(client, this.list(message.id));
        return;
      case "ext.call":
        this.relayCall(client, message);
        return;
      case "ext.result":
        this.relayResult(message);
        return;
      default: {
        const never: never = message;
        throw new Error(`unhandled message ${String(never)}`);
      }
    }
  }

  private hello(client: Client, vMin: number, vMax: number, kind: ClientKind, windowId: number | null): void {
    if (client.kind !== null) {
      this.fail(client, "E_PROTO");
      return;
    }
    if (vMax < PROTOCOL_MIN || vMin > PROTOCOL_MAX) {
      client.stale = true;
      this.fail(client, "E_STALE");
      return;
    }
    client.kind = kind;
    client.window = kind === "panel" ? windowId : null;
    if (kind === "sw") {
      this.sw = client;
      this.swConnects += 1;
    }
    this.send(client, {
      type: "hello",
      v: Math.min(vMax, PROTOCOL_MAX),
      build: this.ports.build,
      panes: [...this.panes.values()].map((pane) => ({ id: pane.id, alive: pane.alive })),
      notices: [],
    });
  }

  /** The pane's PTY when `client` owns the live pane, else null after E_NOPANE. */
  private owned(client: Client, id: string): Pty | null {
    const pane = this.panes.get(id);
    if (pane === undefined || pane.owner !== client || !pane.alive || pane.pty === null) {
      this.fail(client, "E_NOPANE", { pane: id });
      return null;
    }
    return pane.pty;
  }

  private async open(client: Client, message: Open): Promise<void> {
    const existing = this.panes.get(message.pane);
    if (existing !== undefined && (existing.alive || existing.starting)) {
      this.take(existing, client);
      existing.cols = message.cols;
      existing.rows = message.rows;
      existing.pty?.resize(message.cols, message.rows);
      this.attached(existing, client);
      return;
    }
    if (existing === undefined && this.panes.size >= PANES_MAX) {
      this.fail(client, "E_LIMIT", { id: message.id, pane: message.pane });
      return;
    }
    const pane: Pane = { id: message.pane, pty: null, owner: client, alive: false, starting: true, cols: message.cols, rows: message.rows };
    this.panes.set(pane.id, pane);
    let shell: PaneShell;
    try {
      shell = await this.ports.shellFor(pane.id);
    } catch {
      shell = { file: "", args: [], cwd: "", env: {}, notice: null };
    }
    const started =
      shell.file === ""
        ? ({ ok: false } as const)
        : this.ports.spawner.spawn({ file: shell.file, args: shell.args, cwd: shell.cwd, env: shell.env, cols: pane.cols, rows: pane.rows });
    pane.starting = false;
    if (!started.ok) {
      this.panes.delete(pane.id);
      this.fail(client, "E_SPAWN", { id: message.id, pane: pane.id });
      return;
    }
    pane.pty = started.pty;
    pane.alive = true;
    started.pty.onData((data) => this.output(pane, data));
    started.pty.onExit((exit) => this.exited(pane, exit));
    if (shell.notice !== null && pane.owner !== null) this.send(pane.owner, { type: "notice", kind: shell.notice });
    if (pane.owner !== null) this.attached(pane, pane.owner);
  }

  /** Makes `client` the pane's owner; a previous owner learns it was taken. */
  private take(pane: Pane, client: Client): void {
    const previous = pane.owner;
    pane.owner = client;
    if (previous !== null && previous !== client) this.send(previous, { type: "detached", pane: pane.id, reason: "taken" });
  }

  /** The new owner's snapshot: empty until slice 2b's mirror, so the panel starts from a reset screen. */
  private attached(pane: Pane, client: Client): void {
    this.send(client, { type: "snapshot", pane: pane.id, part: 0, last: true, cols: pane.cols, rows: pane.rows, data: "" });
  }

  private output(pane: Pane, data: string): void {
    const owner = pane.owner;
    if (owner === null) return;
    for (const part of splitForWire(data, WIRE_DATA_MAX)) {
      if (part !== "") this.send(owner, { type: "out", pane: pane.id, data: part });
    }
  }

  private exited(pane: Pane, exit: PtyExit): void {
    pane.alive = false;
    pane.pty = null;
    if (pane.owner !== null) this.send(pane.owner, { type: "exit", pane: pane.id, code: exit.code, signal: exit.signal });
  }

  private list(id: string): DaemonMessage {
    const panels = [...this.clients]
      .filter((client) => client.kind === "panel" && client.window !== null)
      .map((client) => ({ window: client.window ?? 0 }));
    return {
      type: "panes",
      id,
      panes: [...this.panes.values()]
        .filter((pane) => !pane.starting)
        .map((pane) => ({ id: pane.id, alive: pane.alive, owned: pane.owner !== null })),
      panels,
      sw: { connected: this.sw !== null, connects: this.swConnects },
    };
  }

  private relayCall(caller: Client, message: ExtCall): void {
    const sw = this.sw;
    if (sw === null) {
      this.fail(caller, "E_NOEXT", { id: message.id });
      return;
    }
    this.nextCall += 1;
    const id = `x${this.nextCall}`;
    this.pending.set(id, { caller, id: message.id, sw });
    this.send(sw, message.args === undefined ? { type: "ext.call", id, op: message.op } : { type: "ext.call", id, op: message.op, args: message.args });
    void this.ports.clock.sleep(EXT_CALL_MS).then(() => {
      const call = this.pending.get(id);
      if (call === undefined) return;
      this.pending.delete(id);
      this.fail(call.caller, "E_NOEXT", { id: call.id });
    });
  }

  private relayResult(message: ExtResult): void {
    const call = this.pending.get(message.id);
    if (call === undefined) return;
    this.pending.delete(message.id);
    this.send(call.caller, { ...message, id: call.id });
  }

  private disconnect(client: Client): void {
    if (!this.clients.delete(client)) return;
    for (const pane of this.panes.values()) if (pane.owner === client) pane.owner = null;
    for (const [id, call] of this.pending) if (call.caller === client) this.pending.delete(id);
    if (this.sw === client) this.sw = null;
    for (const [id, call] of this.pending) {
      if (call.sw !== client) continue;
      this.pending.delete(id);
      this.fail(call.caller, "E_NOEXT", { id: call.id });
    }
  }

  private shutdown(mode: "stop" | "restart"): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const pane of this.panes.values()) if (pane.alive) pane.pty?.kill("SIGHUP");
    for (const client of [...this.clients]) client.peer.close();
    this.ports.onShutdown(mode);
  }
}
