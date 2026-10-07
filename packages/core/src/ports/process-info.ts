/** Facts about other processes (docs/IMPLEMENTATION.md §3); it never reads an environment. Adapter: packages/node. */
export interface ProcessInfo {
  /** Whether a process with this pid exists (one owned by someone else counts). */
  alive(pid: number): Promise<boolean>;
}
