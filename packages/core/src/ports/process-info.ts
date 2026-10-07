/** Facts about other processes (docs/IMPLEMENTATION.md §3); it never reads an environment. Adapter: packages/node. */
export interface ProcessInfo {
  /** Whether a process with this pid exists (one owned by someone else counts). */
  alive(pid: number): Promise<boolean>;
  /**
   * When the process with this pid started, in milliseconds since the epoch, to within about a second; `null` when no
   * such process exists or its start cannot be read. A lock compares it with the start its holder recorded, so a pid
   * the system has given to a newer process never keeps a dead holder's lock (D97).
   */
  startedAt(pid: number): Promise<number | null>;
}
