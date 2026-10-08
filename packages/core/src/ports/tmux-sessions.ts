/** A tmux client: the terminal it runs on, and the session it shows. */
export type TmuxClient = { tty: string; session: string };

/**
 * The user's tmux sessions, as cold restore asks about them (docs/IMPLEMENTATION.md §7.4). Adapter: packages/node
 * (`tmux list-clients` and `has-session -t =name`, argv, 3 s); it never reads a session's environment.
 */
export interface TmuxSessions {
  /** Every client of the running server, or `null` when no server runs. */
  clients(): Promise<readonly TmuxClient[] | null>;
  /** Whether a session has exactly this name (`=name`). */
  hasSession(name: string): Promise<boolean>;
}
