import { connect, createServer } from "node:net";
import type { PortProbe } from "@desk/core";
import { assertPortAllowed } from "./test-guard.ts";

/** A loopback connect answers at once, accepted or refused; a full backlog (macOS drops the SYN) waits this long. */
const CONNECT_TIMEOUT_MS = 1_000;

function errorCode(err: unknown): string | undefined {
  return err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

/**
 * Whether something accepts TCP connections on 127.0.0.1:port. A holder bound to 0.0.0.0 or :: (dual-stack) accepts
 * them too. A timeout counts as accepted: a port that behaves oddly is not one to choose.
 */
function acceptsOnLoopback(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (err) => {
      socket.destroy();
      const code = errorCode(err);
      if (code === "ECONNREFUSED") resolve(false);
      else if (code === "ABORT_ERR" || code === "ECONNRESET" || code === "ETIMEDOUT") resolve(true);
      else reject(err);
    });
  });
}

/** Whether this process can bind 127.0.0.1:port right now. */
function bindsOnLoopback(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise<boolean>((resolve, reject) => {
    server.once("error", (err) => {
      const code = errorCode(err);
      if (code === "EADDRINUSE" || code === "EACCES") resolve(false);
      else reject(err);
    });
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * A port is free when nothing accepts a connection on 127.0.0.1 and this process can bind it there, where Chrome and
 * the guarded endpoint listen. The connection comes first because macOS lets a 127.0.0.1 bind share a port another
 * program holds on 0.0.0.0 or ::, and Desk would then take that program's loopback traffic. Binding 0.0.0.0 to find
 * out instead would be a listener beyond loopback (§20), and the macOS firewall may ask about it on screen.
 */
export class NodePortProbe implements PortProbe {
  async isFree(port: number): Promise<boolean> {
    assertPortAllowed(port);
    if (await acceptsOnLoopback(port)) return false;
    return bindsOnLoopback(port);
  }
}
