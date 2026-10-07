import { connect, type Socket } from "node:net";
import type { DaemonDialer, DialResult } from "@desk/core";
import { assertPathAllowed } from "@desk/node";

/** The host's connect to the daemon, including starting it, takes at most 3 s (§6.6); one attempt gets this much. */
const CONNECT_MS = 1_000;

/** Connects to `run/ptyd.sock`; a missing or refusing socket is `dead`, so the host may start the daemon (§8). */
export class UnixDaemonDialer implements DaemonDialer<Socket> {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async connect(): Promise<DialResult<Socket>> {
    await assertPathAllowed(this.path);
    return new Promise((resolve) => {
      const socket = connect({ path: this.path });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve({ ok: false, reason: "failed" });
      }, CONNECT_MS);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve({ ok: true, link: socket });
      });
      socket.once("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: err.code === "ENOENT" || err.code === "ECONNREFUSED" ? "dead" : "failed" });
      });
    });
  }
}
