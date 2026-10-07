/** How a pane's process ended: an exit code, or the signal that ended it. */
export type PtyExit = { code: number | null; signal: number | null };

/** A process on a pseudo-terminal. Desk only ever signals the processes it started. */
export interface Pty {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal: "SIGHUP" | "SIGKILL"): void;
  /** Stops reading the PTY (flow control, §7.3), until `resume`. */
  pause(): void;
  resume(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exit: PtyExit) => void): void;
}

export type PtySpawnOptions = {
  file: string;
  args: readonly string[];
  cwd: string;
  /** The whole environment: nothing is inherited. */
  env: Readonly<Record<string, string>>;
  cols: number;
  rows: number;
};

/**
 * Starts processes on pseudo-terminals (docs/IMPLEMENTATION.md §3). Adapter: packages/ptyd, over the PTY package
 * (D71), which only the daemon and the live suites import.
 */
export interface PtySpawner {
  spawn(options: PtySpawnOptions): { ok: true; pty: Pty } | { ok: false };
}
