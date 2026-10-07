/** A pane's headless terminal, which parses everything the shell prints (docs/IMPLEMENTATION.md §7.3). */
export interface MirrorScreen {
  /** Queues `data`; it is parsed later, in order. */
  write(data: string): Promise<void>;
  /** Resolves once everything written so far is parsed. */
  flush(): Promise<void>;
  resize(cols: number, rows: number): void;
  /** The parsed screen and scrollback, serialized, and whether it shows the alternate screen. */
  snapshot(): { data: string; altScreen: boolean };
  dispose(): void;
}

/**
 * Makes the mirror of each pane (docs/IMPLEMENTATION.md §3, §7.3). It is never connected to the PTY: a terminal query
 * the shell prints is answered only by the owner's xterm. Adapter: packages/ptyd (@xterm/headless and addon-serialize).
 */
export interface TerminalMirror {
  create(cols: number, rows: number, scrollback: number): MirrorScreen;
}
