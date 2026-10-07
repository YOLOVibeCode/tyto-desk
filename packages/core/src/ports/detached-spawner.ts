/**
 * Starts a process in its own session with stdio ignored and an explicit environment, and does not wait for it
 * (docs/IMPLEMENTATION.md §3). Adapter: packages/node. The native host starts the terminal daemon this way.
 */
export interface DetachedSpawner {
  /** The new process's pid, or `null` when it could not start. */
  spawn(file: string, args: readonly string[], env: Readonly<Record<string, string>>): Promise<number | null>;
}
