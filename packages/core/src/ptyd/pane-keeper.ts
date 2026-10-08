import type { Clock } from "../ports/clock.ts";
import type { PaneRecord, PaneStore, PanesFile } from "../ports/pane-store.ts";
import type { ProcessCwd } from "../ports/process-cwd.ts";
import type { ShellProbe } from "../ports/shell-probe.ts";
import type { TmuxSessions } from "../ports/tmux-sessions.ts";

export type PaneKeeperPorts = {
  store: PaneStore;
  cwds: ProcessCwd;
  probe: ShellProbe;
  /** The user's tmux sessions; `null` when tmux is not installed. */
  sessions: TmuxSessions | null;
  clock: Clock;
};

/** How a pane the daemon does not have comes back (§7.4's table). */
export type RestorePlan =
  | { attach: string; cwd: string | null }
  | { shell: true; cwd: string | null; waitFor: string | null };

/** `panes.json` is written this long after the last change (§7.4). */
const SAVE_DEBOUNCE_MS = 1_000;
/** The cwd and tmux session are read this long after a command is entered. */
const ENTERED_REFRESH_MS = 1_000;
/** And this often while the shell runs. */
const PERIODIC_REFRESH_MS = 30_000;

/**
 * What each pane leaves for its cold restore (docs/IMPLEMENTATION.md §7.4), kept by the daemon: the shell, its directory
 * (read from its process only, never from OSC 7, which any program can print), and its tmux session, found by matching
 * the shell's terminal in `tmux list-clients`. `lastTmux` keeps the last session through a client's exit, and changes
 * only when the pane attaches to another one or is closed. Read about 1 s after a command is entered and every 30 s;
 * `panes.json` is written 1 s after the last change, and at once on `flush` (SIGTERM, SIGHUP, shutdown). Titles,
 * output and input are never kept.
 */
export class PaneKeeper {
  private readonly ports: PaneKeeperPorts;
  private readonly records = new Map<string, PaneRecord>();
  /** The live shell of each pane: its pid. */
  private readonly live = new Map<string, number>();
  private readonly refreshing = new Set<string>();
  /** The one read of `panes.json`, which every caller waits for: two opens that arrive together both see it. */
  private loading: Promise<{ recovered: boolean }> | null = null;
  private dirty = false;
  private saveScheduled = false;
  /** When `panes.json` was last written (or `-Infinity`). */
  private savedAt = Number.NEGATIVE_INFINITY;
  private ticking = false;

  constructor(ports: PaneKeeperPorts) {
    this.ports = ports;
  }

  /** Reads `panes.json` once; a file moved aside leaves nothing to restore. */
  load(): Promise<{ recovered: boolean }> {
    this.loading ??= this.ports.store.load().then(
      (loaded) => {
        // A pane that started before the read finished keeps what it has.
        for (const [id, record] of Object.entries(loaded.panes?.panes ?? {})) if (!this.records.has(id)) this.records.set(id, record);
        return { recovered: loaded.recovered };
      },
      () => ({ recovered: false }),
    );
    return this.loading;
  }

  /** A pane's shell started: it is kept from now on, and read soon. */
  started(paneId: string, pid: number, shell: string): void {
    const known = this.records.get(paneId);
    this.records.set(paneId, { cwd: known?.cwd ?? null, tmux: null, lastTmux: known?.lastTmux ?? null, shell });
    this.live.set(paneId, pid);
    this.changed();
    this.later(paneId, ENTERED_REFRESH_MS);
    this.tick();
  }

  /** A pane's shell ended; its record stays for a restore. */
  ended(paneId: string): void {
    this.live.delete(paneId);
  }

  /** The user entered a command (an `in` with CR): the directory and session are read about 1 s later. */
  entered(paneId: string): void {
    this.later(paneId, ENTERED_REFRESH_MS);
  }

  /** What the shell printed: never kept, and never a source of the directory (OSC 7 is ignored here on purpose). */
  output(_paneId: string, _data: string): void {}

  /** The user closed the pane: it is forgotten. */
  closed(paneId: string): void {
    this.live.delete(paneId);
    if (this.records.delete(paneId)) this.changed();
  }

  /** The record of a pane, if it left one. */
  record(paneId: string): PaneRecord | undefined {
    return this.records.get(paneId);
  }

  /** §7.4's table for a pane the daemon does not have: attach its live tmux session, or a login shell (that may wait). */
  async plan(paneId: string): Promise<RestorePlan | null> {
    const record = this.records.get(paneId);
    if (record === undefined) return null;
    const name = record.tmux ?? record.lastTmux;
    if (name !== null && this.ports.sessions !== null && (await this.ports.sessions.hasSession(name).catch(() => false))) {
      return { attach: name, cwd: record.cwd };
    }
    return { shell: true, cwd: record.cwd, waitFor: record.lastTmux };
  }

  /** Writes `panes.json` now. */
  async flush(): Promise<void> {
    this.dirty = false;
    this.savedAt = this.ports.clock.now();
    const panes: PanesFile = { version: 1, panes: Object.fromEntries(this.records) };
    await this.ports.store.save(panes).catch(() => undefined);
  }

  /** Reads the pane's directory and tmux session from its shell's process. */
  async refresh(paneId: string): Promise<void> {
    const pid = this.live.get(paneId);
    const record = this.records.get(paneId);
    if (pid === undefined || record === undefined) return;
    const cwd = (await this.ports.cwds.cwdOf(pid).catch(() => null)) ?? record.cwd;
    const tmux = await this.sessionOf(pid);
    // The same pane, still alive: a record replaced meanwhile (closed, or a new shell) is left alone.
    if (this.records.get(paneId) !== record || this.live.get(paneId) !== pid) return;
    const lastTmux = tmux ?? record.lastTmux;
    if (cwd === record.cwd && tmux === record.tmux && lastTmux === record.lastTmux) return;
    this.records.set(paneId, { ...record, cwd, tmux, lastTmux });
    this.changed();
  }

  private async sessionOf(pid: number): Promise<string | null> {
    if (this.ports.sessions === null) return null;
    const tty = await this.ports.probe.ttyOf(pid).catch(() => null);
    if (tty === null) return null;
    const clients = await this.ports.sessions.clients().catch(() => null);
    return clients?.find((client) => client.tty === tty)?.session ?? null;
  }

  /** One refresh per pane at a time, `ms` from now. */
  private later(paneId: string, ms: number): void {
    if (this.refreshing.has(paneId)) return;
    this.refreshing.add(paneId);
    void this.ports.clock.sleep(ms).then(async () => {
      this.refreshing.delete(paneId);
      await this.refresh(paneId);
    });
  }

  /** Every 30 s, while any shell runs, each live pane is read again. */
  private tick(): void {
    if (this.ticking) return;
    this.ticking = true;
    void this.ports.clock.sleep(PERIODIC_REFRESH_MS).then(async () => {
      this.ticking = false;
      if (this.live.size === 0) return;
      for (const paneId of [...this.live.keys()]) await this.refresh(paneId);
      this.tick();
    });
  }

  /**
   * A change is written at once when nothing was written in the last second, and changes that follow within that
   * second are written together at its end: a `cd` reaches `panes.json` about 1 s after it was entered.
   */
  private changed(): void {
    this.dirty = true;
    if (this.saveScheduled) return;
    const wait = this.savedAt + SAVE_DEBOUNCE_MS - this.ports.clock.now();
    if (wait <= 0) {
      void this.flush();
      return;
    }
    this.saveScheduled = true;
    void this.ports.clock.sleep(wait).then(async () => {
      this.saveScheduled = false;
      if (this.dirty) await this.flush();
    });
  }
}
