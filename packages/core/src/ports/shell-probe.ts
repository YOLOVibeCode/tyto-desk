/**
 * Facts about a pane's shell the daemon needs for cold restore (docs/IMPLEMENTATION.md §7.4): its terminal, to find
 * its tmux client, and whether it runs anything, so an idle fallback shell can give way to its tmux session. Adapter:
 * packages/node (`/proc` on Linux, `ps` on macOS; argv, 2 s); it never reads an environment.
 */
export interface ShellProbe {
  /** The terminal device the process runs on (`/dev/ttys004`, `/dev/pts/3`), or `null`. */
  ttyOf(pid: number): Promise<string | null>;
  /** Whether the process has child processes now. */
  hasChildren(pid: number): Promise<boolean>;
}
