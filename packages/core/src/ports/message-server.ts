import type { DaemonConnection, DaemonPeer } from "../ptyd/daemon.ts";

/**
 * The daemon's listener on `run/ptyd.sock` (docs/IMPLEMENTATION.md §3, §7.2): NDJSON lines in, one line per message
 * out, at most 1 MiB per line read and 32 connections. Adapter: packages/ptyd (a Unix socket, never a TCP port).
 */
export interface MessageServer {
  /** Starts listening; each connection is handed to `accept`, whose handle gets the connection's lines. */
  listen(accept: (peer: DaemonPeer) => DaemonConnection): Promise<void>;
  close(): Promise<void>;
}
