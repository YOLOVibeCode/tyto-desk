import { checkLayout, defaultLayout, type Layout } from "../layout/layout.ts";
import type { Clock } from "../ports/clock.ts";
import type { LayoutStore } from "../ports/layout-store.ts";
import type { PaneStore } from "../ports/pane-store.ts";
import type { ProcessCwd } from "../ports/process-cwd.ts";
import type { ShellProbe } from "../ports/shell-probe.ts";
import type { TmuxSessions } from "../ports/tmux-sessions.ts";
import { PaneKeeper } from "./pane-keeper.ts";
import type { LogSink } from "../ports/log-sink.ts";
import type { MirrorScreen, TerminalMirror } from "../ports/terminal-mirror.ts";
import { EscapeTail } from "../term/escape-tail.ts";
import { ModeTracker } from "../term/modes.ts";
import type { DaemonConnection, DaemonPeer } from "../ports/message-server.ts";
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
  type PanelTerminal,
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
  /** The pane's login shell, which `panes.json` keeps (for a tmux attach, the shell it falls back to). */
  loginShell: string;
};

/** No shell to start: the spawn fails with E_SPAWN. */
const NO_SHELL: PaneShell = { file: "", args: [], cwd: "", env: {}, notice: null, loginShell: "" };

/** A restored pane's one dim line (§7.4). */
const ENDED_NOTE = "[Desk: the shell that ran here ended when the terminal daemon stopped; this is a new one]";
const waitingNote = (name: string) => `[Desk: a new shell while tmux session "${name}" comes back; it takes this pane when this shell is idle]`;
/** How often, and how long, a fallback shell's tmux session is looked for (§7.4). */
const SESSION_POLL_MS = 5_000;
const SESSION_WAIT_MS = 10 * 60_000;
/** A fallback shell counts as idle after this long without input (and with no child process). */
const IDLE_INPUT_MS = 5_000;

/** How a pane's shell starts: in a directory, attached to a tmux session, with a dim line, waiting for a session. */
type Spawn = { cwd: string | null; attach?: string; note?: string; waitFor?: string | null };

export type DaemonPorts = {
  spawner: PtySpawner;
  clock: Clock;
  /** This daemon's version, for `hello`. */
  build: string;
  /**
   * The new pane's shell; `cwd` is the directory it should start in (a split's, a new tab's, or a restored pane's),
   * when there is one; `attach` makes it `tmux attach-session -t =<name>` (§7.4).
   */
  shellFor(pane: string, cwd: string | null, attach?: string): Promise<PaneShell>;
  cwds: ProcessCwd;
  /** `panes.json`, the shell facts and the tmux sessions cold restore uses (§7.4). */
  paneStore: PaneStore;
  probe: ShellProbe;
  sessions: TmuxSessions | null;
  /** Called once, after a shutdown was accepted and every running shell got SIGHUP. */
  onShutdown(mode: "stop" | "restart"): void;
  layouts: LayoutStore;
  log: LogSink;
  /** Each pane's headless terminal (§7.3). */
  mirror: TerminalMirror;
  /** Lines of scrollback a mirror keeps (`terminal.scrollback`). */
  scrollback: number;
  /** `terminal.closeOnExit`, which panels learn in `hello`. */
  closeOnExit?: boolean;
  /** The terminal settings panels learn in `hello` (§10). */
  terminal?: PanelTerminal;
};

/** The panes Desk keeps at most (§7.2). */
const PANES_MAX = 64;

/** How long the daemon waits for the service worker to answer an extension call (§6.6). */
const EXT_CALL_MS = 2_000;

/** §7.3's output and flow-control numbers (VS Code's). */
const QUIET_MS = 4;
const COALESCE_MAX = 65_536;
const PAUSE_ABOVE = 100_000;
const RESUME_BELOW = 5_000;
const STUCK_MS = 10_000;
/** The PTY also pauses while the mirror is this far behind, and resumes below the second (D106). */
const MIRROR_PAUSE_ABOVE = 1_000_000;
const MIRROR_RESUME_BELOW = 100_000;

/** What each client kind may send after hello (§7.2's table). */
const VERBS: Readonly<Record<ClientKind, readonly ClientMessage["type"][]>> = {
  panel: ["layout.get", "layout.put", "open", "in", "resize", "ack", "visibility", "detach", "attach", "close", "list", "shutdown"],
  sw: ["ext.result"],
  cli: ["list", "layout.get", "ext.call", "agents.state", "shutdown"],
  watch: ["list", "alert", "ext.call", "gateway.state"],
};

type Client = { peer: DaemonPeer; kind: ClientKind | null; window: number | null; stale: boolean; hidden: boolean };

/** An alert this recent reaches a panel that says hello after it (a panel reopened as it was raised). */
const ALERT_REPLAY_MS = 30_000;

type Pane = {
  id: string;
  pty: Pty | null;
  owner: Client | null;
  alive: boolean;
  starting: boolean;
  cols: number;
  rows: number;
  /** The pane's mirror, its unfinished escape sequence, and the modes serialize does not write. */
  screen: MirrorScreen | null;
  tail: EscapeTail;
  modes: ModeTracker;
  /** Output that arrived while a client attaches: it reaches the mirror and the owner after the snapshot. */
  held: string[] | null;
  /** Output coalesced for the owner, when the last went out, and whether a send is scheduled (§7.3). */
  buffer: string;
  lastOut: number;
  flushScheduled: boolean;
  /** Characters sent to the owner and not yet acknowledged; the PTY pauses above 100,000. */
  unacked: number;
  paused: boolean;
  /** Bumps whenever the pane resumes or changes owner, so an older stuck check does nothing. */
  flowEpoch: number;
  /** Characters written to the mirror and not yet parsed; the PTY also pauses above 1,000,000. */
  mirrorBehind: number;
  mirrorPaused: boolean;
  /** Whether the PTY is paused now: for the owner, for the mirror, or both. */
  ptyPaused: boolean;
  /** When the owner last typed into the pane. */
  lastInput: number;
  /** A tmux attach: when its client exits, the pane goes on as a login shell (§7.4). */
  attached?: boolean;
  /** The tmux session a fallback shell waits for (§7.4). */
  waitingFor?: string;
  /** The shell's exit is a replacement: the pane goes on with this attach. */
  replaceWith?: string;
};

/** An extension call on its way: who asked, under which id, and the worker it went to. */
type PendingCall = { caller: Client; id: string; sw: Client };

/**
 * The terminal daemon's state machine (docs/IMPLEMENTATION.md §7): clients and what they may send, panes and their one
 * owner each, input to the owner's shell and output to the owner only, and the extension calls it relays between the
 * launcher and the service worker. Each pane has a mirror, so a re-attached pane starts from its screen (§7.3). It never
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
  private readonly keeper: PaneKeeper;
  /** The layout as saved, loaded at the first ask; `null` until then or when none is saved. */
  /** When each alert from `desk watch` was last raised, to replay recent ones to a panel that says hello late. */
  private readonly alerts = new Map<string, number>();
  private layout: Layout | null = null;
  private layoutLoaded: Promise<void> | null = null;
  private gatewayClients = 0;
  private paused = false;

  constructor(ports: DaemonPorts) {
    this.keeper = new PaneKeeper({ store: ports.paneStore, cwds: ports.cwds, probe: ports.probe, sessions: ports.sessions, clock: ports.clock });
    this.ports = ports;
  }

  connect(peer: DaemonPeer): DaemonConnection {
    const client: Client = { peer, kind: null, window: null, stale: false, hidden: false };
    this.clients.add(client);
    return {
      receive: (line) => this.receive(client, line),
      refused: (size) => {
        this.ports.log.write({ event: "line-refused", size });
        this.fail(client, "E_PROTO");
      },
      closed: () => this.disconnect(client),
    };
  }

  /** Ends the daemon as a `shutdown {mode: "stop"}` does; its process calls this on SIGTERM and SIGHUP (D97). */
  stop(): void {
    this.shutdown("stop");
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
      // Only the size: a malformed line, or a parser's error about it, can quote what a client typed.
      this.ports.log.write({ event: "bad-line", size: line.length });
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
      case "in": {
        const pty = this.owned(client, message.pane);
        if (pty === null) return;
        pty.write(message.data);
        const pane = this.panes.get(message.pane);
        if (pane !== undefined) pane.lastInput = this.ports.clock.now();
        // A command entered: its directory is read about 1 s later (§7.4).
        if (message.data.includes("\r")) this.keeper.entered(message.pane);
        return;
      }
      case "attach": {
        // The panel's answer to "tmux-back": the busy fallback shell gives way now, as the user chose.
        const pane = this.panes.get(message.pane);
        if (pane !== undefined && pane.owner === client && pane.waitingFor !== undefined) this.replaceWithAttach(pane, pane.waitingFor);
        return;
      }
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
        pane.screen?.resize(message.cols, message.rows);
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
      case "layout.get":
        void this.layoutFor().then((layout) => this.send(client, { type: "layout", id: message.id, layout }));
        return;
      case "layout.put":
        void this.putLayout(client, message.id, message.layout);
        return;
      case "close":
        this.close(client, message.id, message.pane);
        return;
      case "detach": {
        const pane = this.panes.get(message.pane);
        if (pane !== undefined && pane.owner === client) pane.owner = null;
        return;
      }
      case "ack": {
        const pane = this.panes.get(message.pane);
        if (pane === undefined || pane.owner !== client) return;
        pane.unacked = Math.max(0, pane.unacked - message.n);
        if (pane.paused && pane.unacked < RESUME_BELOW) this.resume(pane);
        return;
      }
      case "visibility":
        // A hidden owner gets no output and never pauses its panes; on visible the panel opens its panes again.
        client.hidden = message.state === "hidden";
        if (client.hidden) for (const pane of this.panes.values()) if (pane.owner === client) this.resetFlow(pane);
        return;
      case "alert":
        this.alerts.set(message.kind, this.ports.clock.now());
        this.broadcast({ type: "alert", kind: message.kind });
        return;
      case "agents.state":
        this.paused = message.paused;
        this.broadcast({ type: "notice", kind: message.paused ? "agents-paused" : "agents-resumed" });
        return;
      case "gateway.state":
        this.gatewayClients = message.clients;
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
    const greet = (layout: Layout | null) =>
      this.send(client, {
        type: "hello",
        v: Math.min(vMax, PROTOCOL_MAX),
        build: this.ports.build,
        panes: [...this.panes.values()].map((pane) => ({ id: pane.id, alive: pane.alive })),
        notices: [],
        ...(kind === "panel" && this.ports.closeOnExit !== undefined ? { closeOnExit: this.ports.closeOnExit } : {}),
        ...(kind === "panel" && this.ports.terminal !== undefined ? { terminal: this.ports.terminal } : {}),
        ...(layout === null ? {} : { layout }),
      });
    // A panel gets the layout with its hello: it lays out its panes at once, without a layout.get round trip (§10).
    if (kind === "panel") {
      void this.layoutFor().then((layout) => {
        greet(layout);
        // An alert raised while this panel was still connecting (a panel desk watch just reopened) reaches it too.
        const now = this.ports.clock.now();
        for (const [alertKind, at] of this.alerts) if (now - at <= ALERT_REPLAY_MS) this.send(client, { type: "alert", kind: alertKind });
      });
    } else greet(null);
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
      if (existing.cols !== message.cols || existing.rows !== message.rows) {
        // A plain shell re-attached at its own size gets no SIGWINCH: zsh would print a stray prompt.
        existing.cols = message.cols;
        existing.rows = message.rows;
        existing.pty?.resize(message.cols, message.rows);
        existing.screen?.resize(message.cols, message.rows);
      }
      if (!existing.starting) await this.attached(existing, client);
      return;
    }
    if (existing === undefined) {
      // An exited pane no panel owns stays listed until the next open; a new one takes its place (§7.3).
      for (const [id, pane] of this.panes) {
        if (pane.alive || pane.starting || pane.owner !== null) continue;
        pane.screen?.dispose();
        this.panes.delete(id);
      }
      if (this.panes.size >= PANES_MAX) {
        this.fail(client, "E_LIMIT", { id: message.id, pane: message.pane });
        return;
      }
    }
    // An exited pane opened again starts its new shell with a new mirror.
    existing?.screen?.dispose();
    const pane: Pane = {
      id: message.pane,
      pty: null,
      owner: client,
      alive: false,
      starting: true,
      cols: message.cols,
      rows: message.rows,
      screen: null,
      tail: new EscapeTail(),
      modes: new ModeTracker(),
      held: null,
      buffer: "",
      lastOut: Number.NEGATIVE_INFINITY,
      flushScheduled: false,
      unacked: 0,
      paused: false,
      flowEpoch: 0,
      mirrorBehind: 0,
      mirrorPaused: false,
      ptyPaused: false,
      lastInput: this.ports.clock.now(),
    };
    this.panes.set(pane.id, pane);
    // A split or a new tab starts where the focused pane's shell is (§10), read from its process.
    const from = message.cwdFrom === undefined ? undefined : this.panes.get(message.cwdFrom);
    const fromCwd = from?.pty === null || from?.pty === undefined || !from.alive ? null : await this.ports.cwds.cwdOf(from.pty.pid).catch(() => null);
    // A pane this daemon never had, that panes.json knows: §7.4's cold restore.
    await this.keeper.load();
    const plan = existing === undefined && message.cwdFrom === undefined ? await this.keeper.plan(pane.id) : null;
    if (plan !== null) this.ports.log.write({ event: "pane-restored", how: "attach" in plan ? "attach" : plan.waitFor === null ? "shell" : "waiting" });
    const how: Spawn =
      plan === null
        ? { cwd: fromCwd }
        : "attach" in plan
          ? { cwd: plan.cwd, attach: plan.attach }
          : { cwd: plan.cwd, note: plan.waitFor === null ? ENDED_NOTE : waitingNote(plan.waitFor), waitFor: plan.waitFor };
    if (!(await this.spawnShell(pane, how))) {
      this.panes.delete(pane.id);
      this.fail(client, "E_SPAWN", { id: message.id, pane: pane.id });
      return;
    }
    if (pane.owner !== null) await this.attached(pane, pane.owner);
  }

  /**
   * Starts the pane's shell as `how` says, keeping its mirror when it already has one (a tmux client that exited, or a
   * fallback shell its session replaced). False when nothing started.
   */
  private async spawnShell(pane: Pane, how: Spawn): Promise<boolean> {
    let shell: PaneShell;
    try {
      shell = how.attach === undefined ? await this.ports.shellFor(pane.id, how.cwd) : await this.ports.shellFor(pane.id, how.cwd, how.attach);
    } catch {
      shell = NO_SHELL;
    }
    const started =
      shell.file === ""
        ? ({ ok: false } as const)
        : this.ports.spawner.spawn({ file: shell.file, args: shell.args, cwd: shell.cwd, env: shell.env, cols: pane.cols, rows: pane.rows });
    pane.starting = false;
    if (!started.ok) return false;
    const pty = started.pty;
    pane.pty = pty;
    pane.alive = true;
    pane.attached = how.attach !== undefined;
    if (how.waitFor !== undefined && how.waitFor !== null) pane.waitingFor = how.waitFor;
    else delete pane.waitingFor;
    pane.screen ??= this.ports.mirror.create(pane.cols, pane.rows, this.ports.scrollback);
    pty.onData((data) => this.output(pane, data));
    pty.onExit((exit) => this.exited(pane, pty, exit));
    this.keeper.started(pane.id, pty.pid, shell.loginShell);
    if (how.note !== undefined) this.output(pane, `\u001b[2m${how.note}\u001b[0m\r\n`);
    if (shell.notice !== null && pane.owner !== null) this.send(pane.owner, { type: "notice", kind: shell.notice });
    if (pane.waitingFor !== undefined) void this.awaitSession(pane, pty, pane.waitingFor);
    return true;
  }

  /**
   * §7.4: for 10 minutes a fallback shell's tmux session is looked for every 5 s; once it exists, an idle shell (no
   * child process, no input for 5 s) gives the pane to it, and a busy one is never replaced: its owner is offered the
   * attach once.
   */
  private async awaitSession(pane: Pane, pty: Pty, name: string): Promise<void> {
    const deadline = this.ports.clock.now() + SESSION_WAIT_MS;
    let offered = false;
    while (this.ports.clock.now() < deadline) {
      await this.ports.clock.sleep(SESSION_POLL_MS);
      if (this.shuttingDown || this.panes.get(pane.id) !== pane || pane.pty !== pty || pane.waitingFor !== name) return;
      if (this.ports.sessions === null || !(await this.ports.sessions.hasSession(name).catch(() => false))) continue;
      const quiet = this.ports.clock.now() - pane.lastInput >= IDLE_INPUT_MS;
      if (quiet && !(await this.ports.probe.hasChildren(pty.pid).catch(() => true))) {
        this.replaceWithAttach(pane, name);
        return;
      }
      if (!offered && pane.owner !== null) {
        offered = true;
        this.send(pane.owner, { type: "notice", kind: "tmux-back", pane: pane.id, session: name });
      }
    }
  }

  /** The fallback shell ends, and the pane goes on attached to its tmux session. */
  private replaceWithAttach(pane: Pane, name: string): void {
    if (pane.pty === null) return;
    pane.replaceWith = name;
    delete pane.waitingFor;
    pane.pty.kill("SIGHUP");
  }

  /** Makes `client` the pane's owner; a previous owner learns it was taken. Flow control starts over. */
  private take(pane: Pane, client: Client): void {
    const previous = pane.owner;
    pane.owner = client;
    this.resetFlow(pane);
    if (previous !== null && previous !== client) this.send(previous, { type: "detached", pane: pane.id, reason: "taken" });
  }

  /**
   * §7.3's attach: output is held while the mirror catches up; the snapshot is the serialized screen, then the modes
   * serialize does not write, then the unfinished escape sequence, so the panel's parser ends where the mirror's does;
   * a program in the alternate screen is made to redraw; then the held output follows, exactly once.
   */
  private async attached(pane: Pane, client: Client): Promise<void> {
    const screen = pane.screen;
    if (screen === null) return;
    pane.held ??= [];
    await screen.flush();
    const snapshot = screen.snapshot();
    const data = snapshot.data + pane.modes.replay() + pane.tail.tail();
    const parts = splitForWire(data, WIRE_DATA_MAX).filter((part, index) => part !== "" || index === 0);
    parts.forEach((part, index) => {
      this.send(client, { type: "snapshot", pane: pane.id, part: index, last: index === parts.length - 1, cols: pane.cols, rows: pane.rows, data: part });
    });
    if (snapshot.altScreen && pane.pty !== null) {
      pane.pty.resize(pane.cols, pane.rows - 1);
      pane.pty.resize(pane.cols, pane.rows);
    }
    const held = pane.held;
    pane.held = null;
    for (const chunk of held) this.process(pane, chunk);
  }

  private output(pane: Pane, data: string): void {
    if (pane.held !== null) {
      pane.held.push(data);
      return;
    }
    this.process(pane, data);
  }

  /** Shell output into the mirror and toward the owner. */
  private process(pane: Pane, data: string): void {
    this.mirror(pane, data);
    pane.tail.feed(data);
    pane.modes.feed(data);
    const owner = pane.owner;
    if (owner === null || owner.hidden) return;
    const now = this.ports.clock.now();
    if (pane.buffer === "" && !pane.flushScheduled && now - pane.lastOut >= QUIET_MS) {
      this.deliver(pane, data);
      return;
    }
    pane.buffer += data;
    while (pane.buffer.length >= COALESCE_MAX) {
      this.deliver(pane, pane.buffer.slice(0, COALESCE_MAX));
      pane.buffer = pane.buffer.slice(COALESCE_MAX);
    }
    if (!pane.flushScheduled && pane.buffer !== "") {
      pane.flushScheduled = true;
      void this.ports.clock.sleep(QUIET_MS).then(() => {
        pane.flushScheduled = false;
        const buffered = pane.buffer;
        pane.buffer = "";
        if (buffered !== "") this.deliver(pane, buffered);
      });
    }
  }

  /** Sends output to the owner in messages of at most 65,536 characters, counting it for flow control. */
  private deliver(pane: Pane, data: string): void {
    const owner = pane.owner;
    if (owner === null || owner.hidden) return;
    pane.lastOut = this.ports.clock.now();
    for (let start = 0; start < data.length; start += COALESCE_MAX) {
      for (const part of splitForWire(data.slice(start, start + COALESCE_MAX), WIRE_DATA_MAX)) {
        if (part !== "") this.send(owner, { type: "out", pane: pane.id, data: part });
      }
    }
    pane.unacked += data.length;
    if (!pane.paused && pane.unacked > PAUSE_ABOVE) this.pause(pane);
  }

  /**
   * Into the mirror, which parses on its own time: a shell that prints faster than the mirror parses is paused while
   * the mirror is more than 1,000,000 characters behind, so the mirror never falls far behind (xterm refuses writes past
   * 50 MB waiting).
   */
  private mirror(pane: Pane, data: string): void {
    const screen = pane.screen;
    if (screen === null) return;
    pane.mirrorBehind += data.length;
    void screen.write(data).then(() => {
      pane.mirrorBehind -= data.length;
      if (pane.mirrorPaused && pane.mirrorBehind < MIRROR_RESUME_BELOW) {
        pane.mirrorPaused = false;
        this.applyPause(pane);
      }
    });
    if (!pane.mirrorPaused && pane.mirrorBehind > MIRROR_PAUSE_ABOVE) {
      pane.mirrorPaused = true;
      this.applyPause(pane);
    }
  }

  /** Pauses the PTY while its owner or its mirror is behind, and resumes it once neither is. */
  private applyPause(pane: Pane): void {
    const pause = pane.paused || pane.mirrorPaused;
    if (pause === pane.ptyPaused) return;
    pane.ptyPaused = pause;
    if (pause) pane.pty?.pause();
    else pane.pty?.resume();
  }

  private pause(pane: Pane): void {
    pane.paused = true;
    this.applyPause(pane);
    const epoch = pane.flowEpoch;
    const owner = pane.owner;
    void this.ports.clock.sleep(STUCK_MS).then(() => {
      if (!pane.paused || pane.flowEpoch !== epoch || pane.owner !== owner || owner === null) return;
      // An owner that has not caught up in 10 s is stuck: it is detached, and the pane runs on.
      pane.owner = null;
      this.send(owner, { type: "detached", pane: pane.id, reason: "stuck" });
      this.resetFlow(pane);
    });
  }

  private resume(pane: Pane): void {
    pane.paused = false;
    pane.flowEpoch += 1;
    this.applyPause(pane);
  }

  /** Forgets what the owner has not acknowledged, and resumes a paused PTY. */
  private resetFlow(pane: Pane): void {
    pane.unacked = 0;
    if (pane.paused) this.resume(pane);
    else pane.flowEpoch += 1;
  }

  private exited(pane: Pane, pty: Pty, exit: PtyExit): void {
    if (pane.pty !== pty) return;
    pane.alive = false;
    pane.pty = null;
    this.keeper.ended(pane.id);
    // A closed pane, or one ending with the daemon, never comes back.
    if (this.shuttingDown || this.panes.get(pane.id) !== pane) return;
    const replace = pane.replaceWith;
    delete pane.replaceWith;
    if (replace !== undefined || pane.attached === true) {
      this.ports.log.write({ event: replace !== undefined ? "pane-attached-session" : "pane-tmux-exited", code: exit.code, signal: exit.signal });
      // §7.4: the fallback shell gave the pane to its session; or the tmux client exited, and a login shell goes on in
      // the same directory.
      const cwd = this.keeper.record(pane.id)?.cwd ?? null;
      void this.spawnShell(pane, replace !== undefined ? { cwd, attach: replace } : { cwd }).then((ok) => {
        if (!ok && pane.owner !== null) this.send(pane.owner, { type: "exit", pane: pane.id, code: exit.code, signal: exit.signal });
      });
      return;
    }
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
      gatewayClients: this.gatewayClients,
      paused: this.paused,
    };
  }

  /** Sends to every panel. */
  private broadcast(message: DaemonMessage): void {
    for (const client of this.clients) if (client.kind === "panel" && !client.stale) this.send(client, message);
  }

  private livePanes(): string[] {
    return [...this.panes.values()].filter((pane) => pane.alive || pane.starting).map((pane) => pane.id);
  }

  /** The saved layout, loaded once; a moved-aside file is logged, and without a layout each live pane gets a tab. */
  private async layoutFor(): Promise<Layout> {
    this.layoutLoaded ??= this.ports.layouts.load().then(
      (loaded) => {
        if (loaded.recovered) this.ports.log.write({ event: "state-recovered", file: "layout" });
        this.layout ??= loaded.layout;
      },
      () => undefined,
    );
    await this.layoutLoaded;
    return this.layout ?? defaultLayout(this.livePanes());
  }

  private async putLayout(client: Client, id: string, value: unknown): Promise<void> {
    const layout = checkLayout(value, this.panes.keys());
    if (layout === null) {
      this.fail(client, "E_LIMIT", { id });
      return;
    }
    await this.layoutFor();
    this.layout = layout;
    await this.ports.layouts.save(layout);
    this.broadcast({ type: "layout", layout });
  }

  /** Ends a pane: SIGHUP to its shell, its metadata removed, and `closed` to its owner. */
  private close(client: Client, id: string, paneId: string): void {
    const pane = this.panes.get(paneId);
    if (pane === undefined || (pane.owner !== null && pane.owner !== client)) {
      this.fail(client, "E_NOPANE", { id, pane: paneId });
      return;
    }
    this.panes.delete(paneId);
    this.keeper.closed(paneId);
    if (pane.alive) pane.pty?.kill("SIGHUP");
    pane.screen?.dispose();
    this.send(client, { type: "closed", pane: paneId });
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
    this.ports.log.write({ event: "shutdown", mode });
    // panes.json is written before the daemon goes (§7.4: flushed on SIGTERM, SIGHUP, and shutdown).
    void this.keeper.flush().finally(() => this.ports.onShutdown(mode));
  }
}
