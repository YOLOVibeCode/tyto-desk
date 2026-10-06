import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import { NodePortProbe } from "../src/index.ts";

/** Holds an OS-assigned loopback port (outside Desk's range) for the length of a test. */
async function holdPort(): Promise<{ port: number; server: Server }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  return { port: address.port, server };
}

async function release(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("NodePortProbe", () => {
  it("reports a port another listener holds as busy", async () => {
    const { port, server } = await holdPort();

    expect(await new NodePortProbe().isFree(port)).toBe(false);
    await release(server);
  });

  it("reports a released port as free", async () => {
    const { port, server } = await holdPort();
    await release(server);

    expect(await new NodePortProbe().isFree(port)).toBe(true);
  });
});
