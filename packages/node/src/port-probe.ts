import { createServer } from "node:net";
import type { PortProbe } from "@desk/core";
import { assertPortAllowed } from "./test-guard.ts";

function errorCode(err: unknown): string | undefined {
  return err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

/** A port is free when this process can bind it on 127.0.0.1, where Chrome and the guarded endpoint listen. */
export class NodePortProbe implements PortProbe {
  async isFree(port: number): Promise<boolean> {
    assertPortAllowed(port);
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
}
