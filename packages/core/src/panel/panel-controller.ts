import type { Clock } from "../ports/clock.ts";
import type { HostChannel } from "../ports/host-channel.ts";
import type { HostConnector } from "../ports/host-connector.ts";
import type { Random } from "../ports/random.ts";
import type { TerminalPane, TerminalView } from "../ports/terminal-view.ts";
import { PROTOCOL_MAX, PROTOCOL_MIN, parseDaemonMessage, type DaemonMessage, type ErrorCode, type PaneSummary } from "../protocol/messages.ts";
import { Backoff } from "../time/backoff.ts";

export type PanelPorts = {
  connector: HostConnector;
  view: TerminalView;
  random: Random;
  clock: Clock;
  /** The extension's Desk version. */
  build: string;
  /** The window this panel shows in (the extension's window id). */
  windowId: number;
  /** False when the panel was opened with `focus=0` (an automatic open must not take the keyboard, §9). */
  focusOnLoad: boolean;
};

/** What each notice from the daemon says in the panel's banner. */
const NOTICES: Readonly<Record<string, string>> = {
  "tmux-line-missing": "Agents can't see this Desk until the tmux line is added (desk install); then open a new pane",
  "agents-paused": "Agents are paused: desk agents resume lets them drive this Desk again",
};

/** What each alert from `desk watch` says (§9's panel states: notices and alerts). */
const ALERTS: Readonly<Record<string, string>> = {
  "terminal-attached": "Something is attached to this terminal: DevTools, or a CDP client on the raw port",
  "agent-state-saved": "A Desk agent session saved browser state into your agent-browser files",
};

const EXITED = "\r\n[the shell exited: press Enter for a new one]\r\n";

/** §9's panel-state table: what the banner says in each state. */
const STATES = {
  notInstalled: "Desk isn't installed for this profile: run desk install",
  hostFailed: "Desk couldn't start its terminal host: run desk doctor",
  installDamaged: "Desk's install is damaged: run desk install",
  noDaemon: "The terminal daemon isn't running: run desk doctor",
  messageLimit: "Desk hit a message limit: run desk doctor",
  updated: "Desk was updated. Restart the terminal daemon now? tmux sessions survive.",
} as const;

/** A host whose port closes this soon after it opened, without a hello, counts as one that failed to start. */
const QUICK_CLOSE_MS = 1_000;
/** Quick closes, and identical host drops, the panel tries before it stops (§9). */
const TRIES = 3;

/** What the banner says when the daemon cannot give this panel's pane a shell; Enter tries again. */
const PANE_ERRORS: Readonly<Partial<Record<ErrorCode, string>>> = {
  E_SPAWN: "The shell could not start: press Enter to try again",
  E_LIMIT: "Desk's terminal daemon has no room for another pane: press Enter to try again",
};

/**
 * The side panel (docs/IMPLEMENTATION.md §9 `PanelController`; slice 1c: one pane). It opens its own native connection,
 * says hello with its window, and attaches the daemon's live pane, or a new one at the terminal's size. Typed input
 * goes to the pane and its output to the terminal; a snapshot resets the terminal first. It reconnects with backoff
 * from 100 ms to 2 s and attaches the same pane again. Whatever the host sends passes core's codecs; the rest is
 * dropped.
 */
export class PanelController {
  private readonly ports: PanelPorts;
  private readonly backoff = new Backoff(100, 2_000);
  private channel: HostChannel | null = null;
  private paneId: string | null = null;
  private term: TerminalPane | null = null;
  private attached = false;
  private exited = false;
  private opens = 0;
  private focused = false;
  private failed = false;
  /** The panel stopped reconnecting; its banner says why. */
  private stopped = false;
  /** A host state the banner shows, which a reconnect must not overwrite. */
  private hostBanner = false;
  private openedAt = 0;
  private greeted = false;
  private quickCloses = 0;
  private drops = 0;

  constructor(ports: PanelPorts) {
    this.ports = ports;
  }

  start(): void {
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    const channel = this.ports.connector.open();
    this.channel = channel;
    this.openedAt = this.ports.clock.now();
    this.greeted = false;
    channel.onMessage((message) => {
      if (this.channel === channel) this.receive(parseDaemonMessage(message));
    });
    channel.onDisconnect((error) => {
      if (this.channel !== channel) return;
      this.channel = null;
      this.attached = false;
      if (error !== null && /not found/i.test(error)) {
        this.stop(STATES.notInstalled);
        return;
      }
      if (this.stopped) return;
      const quick = !this.greeted && this.ports.clock.now() - this.openedAt < QUICK_CLOSE_MS;
      this.quickCloses = quick ? this.quickCloses + 1 : 0;
      if (this.quickCloses >= TRIES) {
        this.stop(STATES.hostFailed);
        return;
      }
      if (!this.hostBanner) this.ports.view.banner("Reconnecting to the Desk terminal…");
      void this.ports.clock.sleep(this.backoff.next()).then(() => this.connect());
    });
    channel.post({
      type: "hello",
      vMin: PROTOCOL_MIN,
      vMax: PROTOCOL_MAX,
      client: "panel",
      build: this.ports.build,
      window: this.ports.windowId,
    });
  }

  private post(message: Record<string, unknown>): void {
    this.channel?.post(message);
  }

  /** Stops reconnecting, and says why. */
  private stop(text: string): void {
    this.stopped = true;
    this.ports.view.banner(text);
  }

  private receive(message: DaemonMessage | null): void {
    if (message === null) return;
    switch (message.type) {
      case "hello":
        this.backoff.reset();
        this.greeted = true;
        this.quickCloses = 0;
        this.drops = 0;
        this.hostBanner = false;
        this.ports.view.banner(null);
        this.attach(message.panes);
        return;
      case "host":
        if (message.state === "install-damaged") this.stop(STATES.installDamaged);
        else if (message.state === "no-daemon") {
          this.hostBanner = true;
          this.ports.view.banner(STATES.noDaemon);
        } else {
          this.drops += 1;
          if (this.drops >= TRIES) this.stop(STATES.messageLimit);
        }
        return;
      case "snapshot":
        if (message.pane !== this.paneId || this.term === null) return;
        if (message.part === 0) this.term.reset();
        this.term.write(message.data);
        if (message.last) this.attached = true;
        return;
      case "out":
        if (message.pane === this.paneId) this.term?.write(message.data);
        return;
      case "exit":
        if (message.pane !== this.paneId) return;
        this.exited = true;
        this.attached = false;
        this.term?.write(EXITED);
        return;
      case "detached":
        if (message.pane !== this.paneId) return;
        this.attached = false;
        this.ports.view.banner(message.reason === "taken" ? "Open in another window" : "The terminal was detached");
        return;
      case "notice": {
        const text = NOTICES[message.kind];
        if (text !== undefined) this.ports.view.banner(text);
        return;
      }
      case "error": {
        if (message.code === "E_STALE") {
          // Every daemon understands shutdown, even after E_STALE (§7.2); the host starts the current version's next.
          this.ports.view.banner(STATES.updated, { label: "Restart now", run: () => this.post({ type: "shutdown", mode: "restart" }) });
          return;
        }
        const text = PANE_ERRORS[message.code];
        if (text === undefined || message.pane === undefined || message.pane !== this.paneId) return;
        this.exited = true;
        this.attached = false;
        this.failed = true;
        this.ports.view.banner(text);
        return;
      }
      case "alert": {
        const text = ALERTS[message.kind];
        if (text !== undefined) this.ports.view.banner(text);
        return;
      }
      case "layout":
      case "closed":
      case "panes":
      case "ext.call":
      case "ext.result":
        return;
      default: {
        const never: never = message;
        throw new Error(`unhandled message ${String(never)}`);
      }
    }
  }

  /** Opens this panel's pane when it still runs, else the daemon's first live pane, else a new one. */
  private attach(panes: readonly PaneSummary[]): void {
    const live = panes.filter((pane) => pane.alive).map((pane) => pane.id);
    const keep = this.paneId !== null && !this.exited && live.includes(this.paneId);
    this.open(keep ? (this.paneId ?? "") : (live[0] ?? this.ports.random.id("p")));
  }

  private open(paneId: string): void {
    if (this.paneId !== paneId || this.term === null) {
      this.term?.dispose();
      this.term = this.newTerminal(paneId);
      this.paneId = paneId;
    }
    this.exited = false;
    this.opens += 1;
    const size = this.term.size();
    this.post({ type: "open", id: `o${this.opens}`, pane: paneId, cols: size.cols, rows: size.rows });
  }

  private newTerminal(paneId: string): TerminalPane {
    const term = this.ports.view.create(paneId);
    term.onInput((data) => {
      if (this.term !== term) return;
      if (this.exited) {
        if (!data.includes("\r")) return;
        if (this.failed) {
          this.failed = false;
          this.ports.view.banner(null);
        }
        // The same pane: the daemon starts its new shell there, so exited shells never pile up as panes.
        this.open(paneId);
        return;
      }
      if (this.attached) this.post({ type: "in", pane: paneId, data });
    });
    term.onResize((size) => {
      // Once the pane is opened: the daemon applies a resize even while the pane's shell is still starting.
      if (this.term === term && !this.exited) this.post({ type: "resize", pane: paneId, cols: size.cols, rows: size.rows });
    });
    if (this.ports.focusOnLoad && !this.focused) {
      this.focused = true;
      term.focus();
    }
    return term;
  }
}
