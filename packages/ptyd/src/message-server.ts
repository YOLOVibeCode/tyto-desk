import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { NdjsonLineDecoder, encodeNdjsonLine, type DaemonConnection, type DaemonPeer, type MessageServer } from "@desk/core";
import { assertPathAllowed } from "@desk/node";

/** The most connections the daemon serves at once (§7.2). */
export const CONNECTIONS_MAX = 32;

function errorCode(err: unknown): string | undefined {
  return err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

/** Whether something accepts connections on the socket path. */
function socketAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ path });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/**
 * `run/ptyd.sock` (docs/IMPLEMENTATION.md §7.2): a Unix socket, 0600 in the 0700 run directory, never a TCP port. Each
 * connection reads NDJSON lines with core's decoder, at most 1 MiB each (a longer line ends the connection), and writes
 * each message as one line. A socket file a dead daemon left is replaced; one a live daemon answers on is not.
 */
export class UnixMessageServer implements MessageServer {
  private readonly path: string;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(path: string) {
    this.path = path;
  }

  async listen(accept: (peer: DaemonPeer) => DaemonConnection): Promise<void> {
    const path: string = this.path;
    await assertPathAllowed(path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const existing = await lstat(path).catch((err: unknown) => {
      if (errorCode(err) === "ENOENT") return null;
      throw err;
    });
    if (existing !== null) {
      if (!existing.isSocket()) throw new Error(`${path} exists and is not a socket`);
      if (await socketAnswers(path)) throw new Error(`a daemon already listens on ${path}`);
      await unlink(path);
    }
    const server = createServer((socket) => this.serve(socket, accept));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ path }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(path, 0o600);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    if (server !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private serve(socket: Socket, accept: (peer: DaemonPeer) => DaemonConnection): void {
    if (this.sockets.size >= CONNECTIONS_MAX) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    const encoder = new TextEncoder();
    const decoder = new NdjsonLineDecoder();
    const text = new TextDecoder("utf-8");
    let ended = false;
    const handle = accept({
      send: (message) => {
        const line = encodeNdjsonLine(encoder.encode(JSON.stringify(message)));
        if (line.ok && !socket.destroyed) socket.write(line.line);
      },
      close: () => socket.end(),
    });
    let refused = false;
    socket.on("data", (chunk: Buffer) => {
      if (refused) return;
      const result = decoder.push(chunk);
      for (const line of result.lines) handle.receive(text.decode(line));
      if (!result.ok) {
        // Over 1 MiB: the daemon answers E_PROTO and logs the size, then the connection ends.
        refused = true;
        handle.refused(result.size);
        socket.end();
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      this.sockets.delete(socket);
      if (ended) return;
      ended = true;
      handle.closed();
    });
  }
}
