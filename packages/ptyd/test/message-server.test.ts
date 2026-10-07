import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DaemonConnection, DaemonMessage, DaemonPeer } from "@desk/core";
import { UnixMessageServer } from "../src/index.ts";

/** A short directory for the socket: macOS caps a socket path at 104 bytes. */
async function socketPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "ms-")), "ptyd.sock");
}

/** A server whose connections echo every line back as a notice, and record what they saw. */
async function echoServer(path: string) {
  const lines: string[] = [];
  let closed = 0;
  const server = new UnixMessageServer(path);
  await server.listen((peer: DaemonPeer): DaemonConnection => ({
    receive: (line) => {
      lines.push(line);
      peer.send({ type: "notice", kind: `echo:${line.length}` });
    },
    closed: () => {
      closed += 1;
    },
  }));
  return { server, lines, closed: () => closed };
}

function client(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** The next `count` lines the socket receives, parsed. */
function readLines(socket: Socket, count: number): Promise<DaemonMessage[]> {
  return new Promise((resolve) => {
    let buffer = "";
    const messages: DaemonMessage[] = [];
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        messages.push(JSON.parse(buffer.slice(0, newline)) as DaemonMessage);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      if (messages.length >= count) resolve(messages.slice(0, count));
    });
  });
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe("the daemon's Unix socket", () => {
  it("the message server reads NDJSON lines from each connection, however they are chunked, and writes each message as one line", async () => {
    const path = await socketPath();
    const { server, lines } = await echoServer(path);
    const socket = await client(path);
    const replies = readLines(socket, 2);

    socket.write('{"type":"list",');
    socket.write('"id":"r1"}\n{"type":"li');
    socket.write('st","id":"r2"}\n');

    expect(await replies).toEqual([
      { type: "notice", kind: "echo:25" },
      { type: "notice", kind: "echo:25" },
    ]);
    expect(lines).toEqual(['{"type":"list","id":"r1"}', '{"type":"list","id":"r2"}']);
    socket.destroy();
    await server.close();
  });

  it("the daemon's socket is 0600", async () => {
    const path = await socketPath();
    const { server } = await echoServer(path);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await server.close();
  });

  it("a line over 1 MiB ends that connection, and the daemon keeps serving others", async () => {
    const path = await socketPath();
    const { server, lines, closed } = await echoServer(path);
    const flood = await client(path);
    const ended = new Promise((resolve) => flood.once("close", resolve));

    flood.write("x".repeat(1024 * 1024 + 1));
    await ended;
    const other = await client(path);
    const reply = readLines(other, 1);
    other.write('{"type":"list","id":"r3"}\n');

    expect(await reply).toEqual([{ type: "notice", kind: "echo:25" }]);
    expect(lines).toEqual(['{"type":"list","id":"r3"}']);
    expect(closed()).toBe(1);
    other.destroy();
    await server.close();
  });

  it("the message server accepts at most 32 connections", async () => {
    const path = await socketPath();
    const { server } = await echoServer(path);
    const sockets = await Promise.all(Array.from({ length: 32 }, () => client(path)));
    const extra = await client(path);
    const refused = new Promise((resolve) => extra.once("close", resolve));

    await refused;
    const last = sockets.at(-1);
    if (last === undefined) throw new Error("no sockets");
    const reply = readLines(last, 1);
    last.write('{"type":"list","id":"r4"}\n');

    expect(await reply).toHaveLength(1);
    for (const socket of sockets) socket.destroy();
    await server.close();
  });

  it("a connection that closes is reported once", async () => {
    const path = await socketPath();
    const { server, closed } = await echoServer(path);
    const socket = await client(path);

    socket.end();
    await until(() => closed() === 1);

    expect(closed()).toBe(1);
    await server.close();
  });

  it("listen replaces a stale socket file a dead daemon left", async () => {
    const path = await socketPath();
    const daemon = spawn(process.execPath, ["-e", `require("node:net").createServer().listen({ path: process.argv[1] }, () => console.log("up"))`, path], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    await new Promise((resolve) => daemon.stdout.once("data", resolve));
    daemon.kill("SIGKILL");
    await once(daemon, "exit");
    expect((await lstat(path)).isSocket()).toBe(true);

    const second = await echoServer(path);
    const socket = await client(path);
    const reply = readLines(socket, 1);
    socket.write('{"type":"list","id":"r5"}\n');

    expect(await reply).toHaveLength(1);
    socket.destroy();
    await second.server.close();
  });

  it("the message server refuses a socket path inside the real home under Vitest", async () => {
    const realHome = process.env.DESK_TEST_REAL_HOME ?? userInfo().homedir;
    const server = new UnixMessageServer(join(realHome, ".desk-test-guard-probe", "ptyd.sock"));

    await expect(server.listen(() => ({ receive: () => undefined, closed: () => undefined }))).rejects.toThrow(/real home directory/);
  });
});
