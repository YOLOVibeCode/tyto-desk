import type { DaemonMessage, ExtOp } from "../protocol/messages.ts";

/** A request the CLI and `desk watch` make of the daemon; the adapter gives it an id and matches the reply. */
export type DaemonRequest = { type: "list" } | { type: "ext.call"; op: ExtOp; args?: unknown };

/** An open connection to the daemon, after hello. */
export type DaemonSession = {
  /** The daemon's reply (or its error), or `null` when the connection ended or the reply did not come in time. */
  request(message: DaemonRequest): Promise<DaemonMessage | null>;
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
