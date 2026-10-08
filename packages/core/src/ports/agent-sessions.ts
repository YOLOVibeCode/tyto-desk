/** A running agent-browser session daemon. */
export type AgentSession = { session: string; pid: number };

/**
 * Desk's agent-browser sessions (docs/IMPLEMENTATION.md §3, §11). Adapter: packages/cli (the `.pid` files in agent-browser's
 * socket directory, which Desk panes leave at `~/.agent-browser`; `agent-browser --session <s> close` as argv, with
 * Desk's config and a clean environment, `detachEnvironment`).
 */
export interface AgentSessions {
  /** The running sessions whose names start with `prefix`. */
  list(prefix: string): Promise<readonly AgentSession[]>;
  /** Closes one session; whether agent-browser said it closed. */
  close(session: string): Promise<boolean>;
}
