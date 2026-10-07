import type { Clock } from "../ports/clock.ts";
import type { HostChannel } from "../ports/host-channel.ts";
import type { HostConnector } from "../ports/host-connector.ts";
import type { Random } from "../ports/random.ts";
import type { TerminalPane, TerminalView } from "../ports/terminal-view.ts";
import { PROTOCOL_MAX, PROTOCOL_MIN, parseDaemonMessage, type DaemonMessage, type PaneSummary } from "../protocol/messages.ts";
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
};

const EXITED = "\r\n[the shell exited: press Enter for a new one]\r\n";

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

  constructor(ports: PanelPorts) {
    this.ports = ports;
  }

  start(): void {
    this.connect();
  }

  private connect(): void {
    const channel = this.ports.connector.open();
    this.channel = channel;
    channel.onMessage((message) => {
      if (this.channel === channel) this.receive(parseDaemonMessage(message));
    });
    channel.onDisconnect(() => {
      if (this.channel !== channel) return;
      this.channel = null;
      this.attached = false;
      this.ports.view.banner("Reconnecting to the Desk terminal…");
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

  private receive(message: DaemonMessage | null): void {
    if (message === null) return;
    switch (message.type) {
      case "hello":
        this.backoff.reset();
        this.ports.view.banner(null);
        this.attach(message.panes);
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
      case "error":
        if (message.code === "E_STALE") {
          this.ports.view.banner("Desk was updated. Restart the terminal daemon to use it; tmux sessions survive");
        }
        return;
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
        if (data.includes("\r")) this.open(this.ports.random.id("p"));
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
