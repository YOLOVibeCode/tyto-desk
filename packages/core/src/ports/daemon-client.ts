import type { DaemonMessage, ExtOp } from "../protocol/messages.ts";

/** A request the CLI and `desk watch` make of the daemon; the adapter gives it an id and matches the reply. */
export type DaemonRequest = { type: "list" } | { type: "ext.call"; op: ExtOp; args?: unknown };

/**
 * A message the daemon acts on without a reply: `shutdown` ends the daemon, and with it the connection; `alert` (from
 * `desk watch` only) shows a banner in every panel.
 */
export type DaemonNotice = { type: "shutdown"; mode: "stop" | "restart" } | { type: "alert"; kind: "terminal-attached" | "agent-state-saved" };

/** An open connection to the daemon, after hello. */
export type DaemonSession = {
  /** The daemon's reply (or its error), or `null` when the connection ended or the reply did not come in time. */
  request(message: DaemonRequest): Promise<DaemonMessage | null>;
  /** Sends the notice and resolves once it is written, never waiting for an answer. */
  notify(message: DaemonNotice): Promise<void>;
  close(): void;
};

/**
 * - `unreachable`: nothing listens on `run/ptyd.sock` (the daemon is not running yet).
 * - `stale`: the daemon speaks no protocol version this build does.
 */
export type DaemonOpen = { ok: true; session: DaemonSession } | { ok: false; reason: "unreachable" | "stale" };

/** The daemon as a client of kind `cli` or `watch` sees it (docs/IMPLEMENTATION.md §3). Adapter: packages/cli. */
export interface DaemonClient {
  open(kind: "cli" | "watch"): Promise<DaemonOpen>;
}
