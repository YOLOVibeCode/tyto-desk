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
  /**
   * The pids whose argument line holds `argument` as a whole argument (`--user-data-dir=<dir>`), so Desk can tell whether
   * any process uses its profile (§6.1 step 4); `null` when the process list cannot be read. Only pids leave the adapter.
   */
  withArgument(argument: string): Promise<number[] | null>;
  /** The processes whose executable lies under `dir` (a version's Desk Terminal, native hosts included); `null` when unknown. */
  executablesUnder(dir: string): Promise<readonly { pid: number; exe: string }[] | null>;
}
