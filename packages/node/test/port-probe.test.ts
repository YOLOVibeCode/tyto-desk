import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
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

  it("asks the port with a loopback connection, so a port another program holds on 0.0.0.0 or :: is busy too", async () => {
    // macOS lets a 127.0.0.1 bind share a port another program holds on 0.0.0.0 or ::, so a bind alone would call it
    // free. No test may listen beyond loopback (it could raise the macOS firewall prompt on the operator's screen), so
    // this holds 127.0.0.1 and checks that the probe's connection reached the holder. A probe that never connects
    // leaves `accepted` pending, and the test times out.
    const { port, server } = await holdPort();
    const accepted = once(server, "connection") as Promise<[Socket]>;

    const free = await new NodePortProbe().isFree(port);
    const [socket] = await accepted;
    socket.destroy();
    await release(server);

    expect(free).toBe(false);
  }, 5_000);
});
