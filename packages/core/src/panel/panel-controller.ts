import { checkLayout, defaultLayout, TABS_MAX, type Layout } from "../layout/layout.ts";
import {
  activeTab,
  addTab,
  closePane,
  cyclePane,
  focusPane,
  layoutPanes,
  reconcileLayout,
  resizeFocused,
  selectTab,
  setRatio,
  splitPane,
  toggleZoom,
  type ArrowDirection,
  type SplitDirection,
} from "../layout/ops.ts";
import type { Clock } from "../ports/clock.ts";
import type { HostChannel } from "../ports/host-channel.ts";
import type { HostConnector } from "../ports/host-connector.ts";
import type { LayoutView } from "../ports/layout-view.ts";
import type { PageVisibility } from "../ports/page-visibility.ts";
import type { Random } from "../ports/random.ts";
import type { BannerAction, KeyInput, MenuItem, TerminalPane, TerminalView } from "../ports/terminal-view.ts";
import { PROTOCOL_MAX, PROTOCOL_MIN, parseDaemonMessage, type DaemonMessage, type ErrorCode, type PaneSummary, type PanelTerminal } from "../protocol/messages.ts";
import { buildKeymap, keyDecision, type PanelAction } from "../term/keymap.ts";
import { sanitizePaste } from "../term/paste.ts";
import { Backoff } from "../time/backoff.ts";

export type PanelPorts = {
  connector: HostConnector;
  view: TerminalView;
  layout: LayoutView;
  random: Random;
  clock: Clock;
  /** The extension's Desk version. */
  build: string;
  /** The window this panel shows in (the extension's window id). */
  windowId: number;
  /** False when the panel was opened with `focus=0` (an automatic open must not take the keyboard, §9). */
  focusOnLoad: boolean;
  visibility: PageVisibility;
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
const NARROW = "Split down: the panel is too narrow for two 80-column panes";
const TOO_MANY_TABS = `Desk holds at most ${TABS_MAX} tabs`;

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
/** The panel acknowledges output in steps of this many characters written (§7.3). */
const ACK_EVERY = 5_000;
/** How many of its own recent layouts the panel remembers, to know their broadcasts as echoes. */
const ECHOES = 16;
/** The terminal settings when the daemon's hello has none (an older daemon): `config.json`'s defaults. */
const DEFAULT_TERMINAL: PanelTerminal = {
  fontFamily: "Menlo, 'SF Mono', 'DejaVu Sans Mono', monospace",
  fontSize: 13,
  scrollback: 5_000,
  macOptionIsMeta: false,
  osc52Write: false,
  keymap: {},
};
const FONT_MIN = 6;
const FONT_MAX = 72;

/** What the banner says when the daemon cannot give a pane a shell; Enter tries again. */
const PANE_ERRORS: Readonly<Partial<Record<ErrorCode, string>>> = {
  E_SPAWN: "The shell could not start: press Enter to try again",
  E_LIMIT: "Desk's terminal daemon has no room for another pane: press Enter to try again",
};

/** One pane's terminal in this panel, and where it stands with the daemon. */
type PaneState = {
  readonly id: string;
  readonly term: TerminalPane;
  /** The snapshot arrived: typed input goes to the pane. */
  attached: boolean;
  /** Opened by this panel (and not since taken by another window). */
  owned: boolean;
  exited: boolean;
  failed: boolean;
  /** Characters written to the terminal since the last ack. */
  written: number;
};

/**
 * The side panel (docs/IMPLEMENTATION.md §9 `PanelController`, §10's tabs and splits). It opens its own native
 * connection and says hello with its window; the daemon's hello carries the layout, which the panel reconciles with the
 * live panes (a live pane the layout lacks becomes a tab; a pane the daemon lost stays, and its shell starts again when
 * opened), shows, and opens pane by pane. Every change the user makes (split, close, new tab, focus, zoom, resize, a
 * dragged divider, a picked tab) goes to the daemon as `layout.put`; the daemon writes `layout.json` and broadcasts it to
 * every panel, and a panel shows another window's change without taking its panes. Typed input goes to a pane once its
 * snapshot arrived, and its output to its terminal; a snapshot resets the terminal first. It reconnects with backoff
 * from 100 ms to 2 s. Whatever the host sends passes core's codecs; the rest is dropped.
 */
export class PanelController {
  private readonly ports: PanelPorts;
  private readonly backoff = new Backoff(100, 2_000);
  private channel: HostChannel | null = null;
  private layout: Layout | null = null;
  private readonly panes = new Map<string, PaneState>();
  /** JSON of the layouts this panel sent, oldest first: their broadcasts come back to it as echoes. */
  private readonly sent: string[] = [];
  private opens = 0;
  private puts = 0;
  /** The panel took the keyboard once already (focus on load happens once). */
  private focusedOnce = false;
  /** The panel stopped reconnecting; its banner says why. */
  private stopped = false;
  /** A host state the banner shows, which a reconnect must not overwrite. */
  private hostBanner = false;
  private openedAt = 0;
  private greeted = false;
  private quickCloses = 0;
  /** Whether the banner shows the agents-paused notice, which `agents-resumed` clears. */
  private pausedShown = false;
  private drops = 0;
  private closeOnExit = false;
  private closes = 0;
  private settings: PanelTerminal = DEFAULT_TERMINAL;
  private keymap = buildKeymap({}).keymap;
  /** The font size every terminal has now; `null` before the first configure. */
  private fontApplied: number | null = null;

  constructor(ports: PanelPorts) {
    this.ports = ports;
  }

  start(): void {
    this.ports.visibility.onChange((state) => {
      this.post({ type: "visibility", state });
      // A hidden owner got no output (§7.3): shown again, the panel opens its panes for fresh snapshots.
      if (state === "visible" && this.channel !== null) {
        for (const pane of this.panes.values()) if (pane.owned && !pane.exited) this.open(pane.id);
      }
    });
    this.ports.layout.onSelectTab((tab) => {
      const index = this.layout?.tabs.findIndex((t) => t.id === tab) ?? -1;
      if (index >= 0) this.selectTab(index + 1);
    });
    this.ports.layout.onDrag((tab, path, ratio) => {
      if (this.layout !== null) this.change(setRatio(this.layout, tab, path, ratio));
    });
    this.connect();
  }

  // ---- What the user does (the keymap and the context menu call these, slice 6b) ----

  /** Splits the focused pane; a new pane opens in its directory and takes the focus. */
  split(direction: SplitDirection): void {
    const layout = this.layout;
    const focused = this.focusedPane();
    if (layout === null || focused === null) return;
    const added = this.ports.random.id("p");
    const split = splitPane(layout, { pane: focused.id, added, direction, cols: focused.term.size().cols });
    if (split.direction !== direction) this.ports.layout.note(NARROW);
    this.ensure(added);
    this.change(split.layout);
    this.open(added, focused.id);
    this.focusTerminal(added);
  }

  /** A new tab after the active one, its pane in the focused pane's directory. */
  newTab(): void {
    const layout = this.layout;
    if (layout === null) return;
    if (layout.tabs.length >= TABS_MAX) {
      this.ports.layout.note(TOO_MANY_TABS);
      return;
    }
    const from = this.focusedPane()?.id;
    const pane = this.ports.random.id("p");
    const tab = this.ports.random.id("t");
    this.ensure(pane);
    this.change(addTab(layout, { tab, pane }));
    this.open(pane, from);
    this.focusTerminal(pane);
  }

  /** Closes the focused pane (its shell ends); the last pane of the last tab leaves a fresh one. */
  closeFocused(): void {
    const focused = this.focusedPane();
    if (focused !== null) this.closeOne(focused.id);
  }

  focusNext(): void {
    this.moveFocus(1);
  }

  focusPrevious(): void {
    this.moveFocus(-1);
  }

  /** Terminal tab `n` (1–9); past the last tab, the last. */
  selectTab(n: number): void {
    if (this.layout === null) return;
    this.change(selectTab(this.layout, n));
    const focus = this.focusedPane();
    if (focus !== null) focus.term.focus();
  }

  zoom(): void {
    if (this.layout !== null) this.change(toggleZoom(this.layout));
  }

  resize(arrow: ArrowDirection): void {
    if (this.layout !== null) this.change(resizeFocused(this.layout, arrow));
  }

  /** A keymap action (§10's table), on the pane it was pressed in. */
  private run(action: PanelAction, pane: PaneState): void {
    switch (action) {
      case "new-tab":
        return this.newTab();
      case "close":
        return this.closeFocused();
      case "split-right":
        return this.split("right");
      case "split-down":
        return this.split("down");
      case "previous":
        return this.focusPrevious();
      case "next":
        return this.focusNext();
      case "zoom":
        return this.zoom();
      case "resize-left":
        return this.resize("left");
      case "resize-right":
        return this.resize("right");
      case "resize-up":
        return this.resize("up");
      case "resize-down":
        return this.resize("down");
      case "tab-1":
      case "tab-2":
      case "tab-3":
      case "tab-4":
      case "tab-5":
      case "tab-6":
      case "tab-7":
      case "tab-8":
      case "tab-9":
        return this.selectTab(Number(action.slice(4)));
      case "find":
        return pane.term.find("open");
      case "find-next":
        return pane.term.find("next");
      case "find-previous":
        return pane.term.find("previous");
      case "clear":
        return pane.term.clear();
      case "font-larger":
        return this.setFont(this.fontOf(this.layout) + 1);
      case "font-smaller":
        return this.setFont(this.fontOf(this.layout) - 1);
      case "font-reset":
        return this.setFont(null);
      default: {
        const never: never = action;
        throw new Error(`unhandled action ${String(never)}`);
      }
    }
  }

  /** A keydown in a pane: a bound action, or a sequence for its shell; false leaves it to the terminal. */
  private key(pane: PaneState, input: KeyInput): boolean {
    const decision = keyDecision(input, this.keymap);
    if (decision === null) return false;
    if ("send" in decision) {
      if (pane.attached && !pane.exited) this.post({ type: "in", pane: pane.id, data: decision.send });
      return true;
    }
    this.run(decision.action, pane);
    return true;
  }

  /** The context menu acts on the pane it was opened on. */
  private menu(pane: PaneState, item: MenuItem): void {
    if (item === "clear") {
      pane.term.clear();
      return;
    }
    if (this.layout !== null && this.focusedPane() !== pane) this.change(focusPane(this.layout, pane.id));
    this.split(item === "split-right" ? "right" : "down");
  }

  /** The hello's terminal settings, and the keymap they give; a binding that cannot be one is named in a note. */
  private takeSettings(settings: PanelTerminal): void {
    this.settings = settings;
    const built = buildKeymap(settings.keymap);
    this.keymap = built.keymap;
    if (built.refused.length > 0) this.ports.layout.note(`terminal.keymap: ${built.refused.join("; ")}`);
  }

  /** The font size a layout asks for (`ui.fontSize`), else `config.json`'s. */
  private fontOf(layout: Layout | null): number {
    const saved = layout?.ui.fontSize;
    return typeof saved === "number" && saved >= FONT_MIN && saved <= FONT_MAX ? saved : this.settings.fontSize;
  }

  /** A new font size (or `null`: back to `config.json`'s), saved in `layout.json` `ui` (§10). */
  private setFont(size: number | null): void {
    if (this.layout === null) return;
    const { fontSize: _dropped, ...ui } = this.layout.ui;
    const next = size === null ? ui : { ...ui, fontSize: Math.min(FONT_MAX, Math.max(FONT_MIN, size)) };
    this.change({ ...this.layout, ui: next });
  }

  /** Every terminal at the layout's font size, configured again only when it changed. */
  private applyFont(force = false): void {
    const size = this.fontOf(this.layout);
    if (!force && size === this.fontApplied) return;
    this.fontApplied = size;
    const { fontFamily, scrollback, macOptionIsMeta } = this.settings;
    this.ports.view.configure({ fontFamily, fontSize: size, scrollback, macOptionIsMeta });
  }

  // ---- The layout ----

  private focusedPane(): PaneState | null {
    const tab = this.layout === null ? undefined : activeTab(this.layout);
    const id = tab?.focus ?? null;
    return id === null ? null : (this.panes.get(id) ?? null);
  }

  private moveFocus(step: 1 | -1): void {
    if (this.layout === null) return;
    this.change(cyclePane(this.layout, step));
    this.focusedPane()?.term.focus();
  }

  private focusTerminal(paneId: string): void {
    this.panes.get(paneId)?.term.focus();
  }

  /** A change this panel made: shown, and sent to the daemon, which writes and broadcasts it. */
  private change(next: Layout): void {
    if (next === this.layout) return;
    this.layout = next;
    this.applyFont();
    this.show();
    this.puts += 1;
    const text = JSON.stringify(next);
    this.sent.push(text);
    if (this.sent.length > ECHOES) this.sent.shift();
    this.post({ type: "layout.put", id: `l${this.puts}`, layout: next });
  }

  private show(): void {
    const layout = this.layout;
    if (layout === null) return;
    const tab = activeTab(layout);
    this.ports.layout.show({
      tabs: layout.tabs.map((t, index) => ({ id: t.id, title: `Terminal ${index + 1}`, marked: false })),
      active: tab?.id ?? null,
      root: tab?.root ?? null,
      zoomed: tab?.zoomed ?? null,
      focus: tab?.focus ?? null,
    });
  }

  /** A layout from the daemon (its hello, or another panel's change), checked against the panes it names. */
  private fromWire(value: Record<string, unknown> | undefined): Layout | null {
    if (value === undefined) return null;
    const named = JSON.stringify(value).match(/p_[0-9abcdefghjkmnpqrstvwxyz]{10}/g) ?? [];
    return checkLayout(value, named);
  }

  /** Another window's change: shown; its new panes get terminals but stay that window's; its closed ones go. */
  private adopt(value: Record<string, unknown>): void {
    const text = JSON.stringify(value);
    const echo = this.sent.indexOf(text);
    if (echo >= 0) {
      this.sent.splice(0, echo + 1);
      return;
    }
    const layout = this.fromWire(value);
    if (layout === null) return;
    this.layout = layout;
    this.applyFont();
    const held = new Set(layoutPanes(layout));
    for (const [id, pane] of this.panes) {
      if (held.has(id)) continue;
      pane.term.dispose();
      this.panes.delete(id);
    }
    for (const id of held) this.ensure(id);
    this.show();
  }

  /** The daemon's hello: the layout it carries (or each live pane in a tab), reconciled, shown, and opened. */
  private greet(live: readonly string[], value: Record<string, unknown> | undefined): void {
    let layout = this.fromWire(value) ?? this.layout ?? defaultLayout(live);
    const reconciled = reconcileLayout(layout, live, (pane) => `t_${pane.slice(2)}`);
    layout = reconciled.layout;
    let changed = reconciled.changed;
    if (layout.tabs.length === 0) {
      layout = addTab(layout, { pane: this.ports.random.id("p"), tab: this.ports.random.id("t") });
      changed = true;
    }
    // The terminals take their settings before any of them is made.
    this.fontApplied = this.fontOf(layout);
    const { fontFamily, scrollback, macOptionIsMeta } = this.settings;
    this.ports.view.configure({ fontFamily, fontSize: this.fontApplied, scrollback, macOptionIsMeta });
    const held = new Set(layoutPanes(layout));
    for (const [id, pane] of this.panes) {
      if (held.has(id)) continue;
      pane.term.dispose();
      this.panes.delete(id);
    }
    for (const id of held) this.ensure(id);
    if (changed) this.change(layout);
    else {
      this.layout = layout;
      this.show();
    }
    for (const id of held) this.open(id);
    const focus = this.focusedPane();
    if (focus !== null && this.ports.focusOnLoad && !this.focusedOnce) {
      this.focusedOnce = true;
      focus.term.focus();
    }
  }

  private closeOne(paneId: string): void {
    const layout = this.layout;
    if (layout === null) return;
    this.closes += 1;
    this.post({ type: "close", id: `c${this.closes}`, pane: paneId });
    const pane = this.panes.get(paneId);
    pane?.term.dispose();
    this.panes.delete(paneId);
    const closed = closePane(layout, paneId);
    if (closed.emptied) {
      // The last pane of the last tab: a fresh pane in a tab of its own, in the home directory.
      const fresh = this.ports.random.id("p");
      this.ensure(fresh);
      this.change(addTab(closed.layout, { pane: fresh, tab: this.ports.random.id("t") }));
      this.open(fresh);
      this.focusTerminal(fresh);
      return;
    }
    this.change(closed.layout);
    this.focusedPane()?.term.focus();
  }

  // ---- The connection ----

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
      for (const pane of this.panes.values()) pane.attached = false;
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
      if (!this.hostBanner) this.showBanner("Reconnecting to the Desk terminal…");
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

  /** Counts what a terminal parsed, and acknowledges it in steps of 5,000 characters. */
  private wrote(paneId: string, length: number): void {
    const pane = this.panes.get(paneId);
    if (pane === undefined) return;
    pane.written += length;
    if (pane.written < ACK_EVERY) return;
    this.post({ type: "ack", pane: paneId, n: pane.written });
    pane.written = 0;
  }

  /** A paste, sanitized; a multi-line one into a program without bracketed paste is confirmed first (§10). */
  private async pasted(pane: PaneState, text: string): Promise<void> {
    const clean = sanitizePaste(text);
    if (clean === "") return;
    if (!pane.term.bracketedPasteMode() && /[\r\n]/.test(clean)) {
      const lines = clean.split(/\r\n|\r|\n/).length;
      if (!(await this.ports.view.confirm(`Paste ${lines} lines?`))) return;
    }
    if (this.panes.get(pane.id) === pane) pane.term.paste(clean);
  }

  /** Every banner goes through here, so `agents-resumed` clears only the paused notice it would have replaced. */
  private showBanner(text: string | null, action?: BannerAction): void {
    this.pausedShown = false;
    if (action === undefined) this.ports.view.banner(text);
    else this.ports.view.banner(text, action);
  }

  /** Stops reconnecting, and says why. */
  private stop(text: string): void {
    this.stopped = true;
    this.showBanner(text);
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
        this.closeOnExit = message.closeOnExit ?? false;
        this.takeSettings(message.terminal ?? DEFAULT_TERMINAL);
        this.showBanner(null);
        this.greet(livePanes(message.panes), message.layout);
        return;
      case "host":
        if (message.state === "install-damaged") this.stop(STATES.installDamaged);
        else if (message.state === "no-daemon") {
          this.hostBanner = true;
          this.showBanner(STATES.noDaemon);
        } else {
          this.drops += 1;
          if (this.drops >= TRIES) this.stop(STATES.messageLimit);
        }
        return;
      case "snapshot": {
        const pane = this.panes.get(message.pane);
        if (pane === undefined) return;
        if (message.part === 0) {
          pane.term.reset();
          pane.written = 0;
        }
        pane.term.write(message.data);
        if (message.last) pane.attached = true;
        return;
      }
      case "out": {
        const paneId = message.pane;
        const pane = this.panes.get(paneId);
        if (pane === undefined) return;
        const length = message.data.length;
        pane.term.write(message.data, () => this.wrote(paneId, length));
        return;
      }
      case "exit": {
        const pane = this.panes.get(message.pane);
        if (pane === undefined || !pane.owned) return;
        pane.exited = true;
        pane.attached = false;
        if (this.closeOnExit) {
          this.closeOne(pane.id);
          return;
        }
        pane.term.write(EXITED);
        return;
      }
      case "detached": {
        const pane = this.panes.get(message.pane);
        if (pane === undefined) return;
        pane.attached = false;
        if (message.reason === "taken") {
          pane.owned = false;
          this.showBanner("This terminal is open in another window", {
            label: "Bring it here",
            run: () => {
              this.showBanner(null);
              for (const away of [...this.panes.values()]) if (!away.owned) this.open(away.id);
            },
          });
        } else if (message.reason === "stuck") {
          // The daemon gave up waiting for this panel's acks; a fresh snapshot catches up.
          this.open(pane.id);
        } else {
          this.showBanner("The terminal was detached");
        }
        return;
      }
      case "notice": {
        if (message.kind === "agents-resumed") {
          if (this.pausedShown) this.showBanner(null);
          this.pausedShown = false;
          return;
        }
        const text = NOTICES[message.kind];
        if (text === undefined) return;
        this.showBanner(text);
        this.pausedShown = message.kind === "agents-paused";
        return;
      }
      case "error": {
        if (message.code === "E_STALE") {
          // Every daemon understands shutdown, even after E_STALE (§7.2); the host starts the current version's next.
          this.showBanner(STATES.updated, { label: "Restart now", run: () => this.post({ type: "shutdown", mode: "restart" }) });
          return;
        }
        const text = PANE_ERRORS[message.code];
        const pane = message.pane === undefined ? undefined : this.panes.get(message.pane);
        if (text === undefined || pane === undefined) return;
        pane.exited = true;
        pane.attached = false;
        pane.failed = true;
        this.showBanner(text);
        return;
      }
      case "alert": {
        const text = ALERTS[message.kind];
        if (text !== undefined) this.ports.view.alert(text);
        return;
      }
      case "layout":
        this.adopt(message.layout);
        return;
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

  // ---- Panes ----

  /** The pane's terminal, made once. */
  private ensure(paneId: string): PaneState {
    const existing = this.panes.get(paneId);
    if (existing !== undefined) return existing;
    const term = this.ports.view.create(paneId);
    const pane: PaneState = { id: paneId, term, attached: false, owned: false, exited: false, failed: false, written: 0 };
    this.panes.set(paneId, pane);
    term.onInput((data) => {
      if (this.panes.get(paneId) !== pane) return;
      if (pane.exited) {
        if (!data.includes("\r")) return;
        if (pane.failed) {
          pane.failed = false;
          this.showBanner(null);
        }
        // The same pane: the daemon starts its new shell there, so exited shells never pile up as panes.
        this.open(paneId);
        return;
      }
      if (pane.attached) this.post({ type: "in", pane: paneId, data });
    });
    term.onPaste((text) => void this.pasted(pane, text));
    term.onResize((size) => {
      // Once the pane is opened: the daemon applies a resize even while the pane's shell is still starting.
      if (this.panes.get(paneId) === pane && pane.owned && !pane.exited) this.post({ type: "resize", pane: paneId, cols: size.cols, rows: size.rows });
    });
    term.onFocus(() => {
      if (this.layout === null || this.focusedPane() === pane) return;
      this.change(focusPane(this.layout, paneId));
    });
    term.onKey((input) => this.panes.get(paneId) === pane && this.key(pane, input));
    term.onMenu((item) => {
      if (this.panes.get(paneId) === pane) this.menu(pane, item);
    });
    return pane;
  }

  /** Opens (attaches, or starts) the pane at its terminal's size; `cwdFrom` names the pane whose directory it starts in. */
  private open(paneId: string, cwdFrom?: string): void {
    const pane = this.ensure(paneId);
    pane.exited = false;
    pane.owned = true;
    this.opens += 1;
    const size = pane.term.size();
    this.post({ type: "open", id: `o${this.opens}`, pane: paneId, cols: size.cols, rows: size.rows, ...(cwdFrom === undefined ? {} : { cwdFrom }) });
  }
}

function livePanes(panes: readonly PaneSummary[]): string[] {
  return panes.filter((pane) => pane.alive).map((pane) => pane.id);
}
