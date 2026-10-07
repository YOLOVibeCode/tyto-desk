import type { DaemonMessage } from "../protocol/messages.ts";

/** One client connection, as the daemon writes to it. */
export interface DaemonPeer {
  send(message: DaemonMessage): void;
  close(): void;
}

/**
 * What the transport tells the daemon about a connection: each line it read, a line it refused for being over 1 MiB
 * (its size only; the connection ends after), and that it closed.
 */
export type DaemonConnection = { receive(line: string): void; refused(size: number): void; closed(): void };

/**
 * The daemon's listener on `run/ptyd.sock` (docs/IMPLEMENTATION.md §3, §7.2): NDJSON lines in, one line per message
 * out, at most 1 MiB per line read and 32 connections. Adapter: packages/ptyd (a Unix socket, never a TCP port).
 */
export interface MessageServer {
  /** Starts listening; each connection is handed to `accept`, whose handle gets the connection's lines. */
  listen(accept: (peer: DaemonPeer) => DaemonConnection): Promise<void>;
  close(): Promise<void>;
}
