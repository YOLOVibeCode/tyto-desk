/**
 * The user's tmux, on its default socket (docs/IMPLEMENTATION.md §3, §7.1). Adapter: packages/node (`tmux` argv, 3 s);
 * it never runs `show-environment`. Desk asks only about the server's options, never a session's environment.
 */
export interface Tmux {
  /** Whether a tmux server answers on the default socket. */
  serverRunning(): Promise<boolean>;
  /** The names in the running server's global `update-environment`, or `null` when no server runs. */
  updateEnvironment(): Promise<readonly string[] | null>;
}
