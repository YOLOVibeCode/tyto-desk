/** What a pane leaves for its cold restore (§7.4): never a title, output or input. */
export type PaneRecord = {
  /** The shell's directory, read from its process (never from OSC 7); `null` until read. */
  cwd: string | null;
  /** The tmux session the pane's client is attached to now. */
  tmux: string | null;
  /** The last tmux session it was attached to, kept through a client's exit (§7.4). */
  lastTmux: string | null;
  /** The login shell it runs. */
  shell: string;
};
export type PanesFile = { version: 1; panes: Record<string, PaneRecord> };

/**
 * `panes.json`, which only the daemon writes (docs/IMPLEMENTATION.md §4.1, §7.4): `load` gives `null` when there is none;
 * a file this build cannot read is moved aside (`recovered`). Adapter: packages/ptyd (atomic 0600 writes).
 */
export interface PaneStore {
  load(): Promise<{ panes: PanesFile | null; recovered: boolean }>;
  save(panes: PanesFile): Promise<void>;
}
