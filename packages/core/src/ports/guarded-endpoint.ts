/**
 * The guarded endpoint `desk watch` serves on `127.0.0.1:<gateway port>` (docs/IMPLEMENTATION.md §12): Chrome's CDP
 * with Desk's own targets hidden and a few commands refused. Adapter: packages/gateway, which follows the Desk Chrome
 * through its own discovery connection and answers 503 while Chrome is down.
 */
export interface GuardedEndpoint {
  /** Starts listening; `port-taken` when another program holds the port. */
  listen(): Promise<{ ok: true } | { ok: false; reason: "port-taken" }>;
  /** Stops listening, ends every client connection, and stops following Chrome. */
  close(): Promise<void>;
}
