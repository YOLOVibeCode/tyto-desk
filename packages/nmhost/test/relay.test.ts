import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { NATIVE_FRAME_MAX, encodeNativeFrame } from "@desk/core";
import { UnixDaemonDialer, relay } from "../src/index.ts";

const encoder = new TextEncoder();

function frame(value: unknown): Uint8Array {
  const encoded = encodeNativeFrame(encoder.encode(JSON.stringify(value)));
  if (!encoded.ok) throw new Error("frame too large");
  return encoded.frame;
}

/** A daemon socket in a short temp directory, whose connections the test sees. */
async function daemonSocket(): Promise<{ path: string; server: Server; connection: Promise<Socket> }> {
  const path = join(await mkdtemp(join(tmpdir(), "nm-")), "ptyd.sock");
  let accept: (socket: Socket) => void = () => undefined;
  const connection = new Promise<Socket>((resolve) => {
    accept = resolve;
  });
  const server = createServer((socket) => accept(socket));
  await new Promise<void>((resolve) => server.listen({ path }, resolve));
  return { path, server, connection };
}

/** Everything `stream` writes, collected. */
function collect(stream: PassThrough): () => Buffer {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  return () => Buffer.concat(chunks);
}

/** Native-messaging payloads in `bytes`, parsed. */
function payloads(bytes: Buffer): unknown[] {
  const out: unknown[] = [];
  for (let offset = 0; offset + 4 <= bytes.length; ) {
    const length = bytes.readUInt32LE(offset);
    out.push(JSON.parse(bytes.subarray(offset + 4, offset + 4 + length).toString("utf8")));
    offset += 4 + length;
  }
  return out;
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe("the native host's relay", () => {
  it("the host relays each native message to the daemon as one NDJSON line and each daemon line back as one native message", async () => {
    const daemon = await daemonSocket();
    const dialed = await new UnixDaemonDialer(daemon.path).connect();
    if (!dialed.ok) throw new Error("no connection");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written = collect(stdout);
    const done = relay({ stdin, stdout, socket: dialed.link });
    const socket = await daemon.connection;
    const lines: string[] = [];
    socket.on("data", (chunk: Buffer) => lines.push(...chunk.toString("utf8").split("\n").filter((line) => line !== "")));

    const hello = frame({ type: "hello", vMin: 1, vMax: 1, client: "panel", build: "0.3.0", window: 7 });
    stdin.write(hello.subarray(0, 3));
    stdin.write(Buffer.concat([hello.subarray(3), frame({ type: "in", pane: "p_k2m9q3x7ab", data: "echo\r" })]));
    socket.write('{"type":"out","pane":"p_k2m9q3x7ab","data":"desk-ok\\r\\n"}\n{"type":"notice","kind":"x"}\n');
    await until(() => lines.length === 2 && payloads(written()).length === 2);
    stdin.end();

    expect(lines).toEqual([
      '{"type":"hello","vMin":1,"vMax":1,"client":"panel","build":"0.3.0","window":7}',
      '{"type":"in","pane":"p_k2m9q3x7ab","data":"echo\\r"}',
    ]);
    expect(payloads(written())).toEqual([
      { type: "out", pane: "p_k2m9q3x7ab", data: "desk-ok\r\n" },
      { type: "notice", kind: "x" },
    ]);
    expect(await done).toBe(0);
    daemon.server.close();
  });

  it("the host closes the daemon connection and exits 0 when Chrome closes its stdin", async () => {
    const daemon = await daemonSocket();
    const dialed = await new UnixDaemonDialer(daemon.path).connect();
    if (!dialed.ok) throw new Error("no connection");
    const stdin = new PassThrough();
    const done = relay({ stdin, stdout: new PassThrough(), socket: dialed.link });
    const socket = await daemon.connection;
    const closed = once(socket, "end");

    stdin.end();

    expect(await done).toBe(0);
    await closed;
    daemon.server.close();
  });

  it("the host drops a frame over 1 MiB and ends both connections", async () => {
    const daemon = await daemonSocket();
    const dialed = await new UnixDaemonDialer(daemon.path).connect();
    if (!dialed.ok) throw new Error("no connection");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written = collect(stdout);
    const done = relay({ stdin, stdout, socket: dialed.link });
    const socket = await daemon.connection;
    const received: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => received.push(chunk));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(NATIVE_FRAME_MAX + 1);

    stdin.write(header);

    expect(await done).toBe(1);
    expect(Buffer.concat(received).length).toBe(0);
    expect(payloads(written())).toEqual([{ type: "host", state: "dropped" }]);
    daemon.server.close();
  });

  it("the host exits 0 when the daemon goes away", async () => {
    const daemon = await daemonSocket();
    const dialed = await new UnixDaemonDialer(daemon.path).connect();
    if (!dialed.ok) throw new Error("no connection");
    const done = relay({ stdin: new PassThrough(), stdout: new PassThrough(), socket: dialed.link });

    (await daemon.connection).destroy();

    expect(await done).toBe(0);
    daemon.server.close();
  });
});

describe("the native host's daemon dialer", () => {
  it("the dialer calls a missing socket dead", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "nm-")), "ptyd.sock");

    expect(await new UnixDaemonDialer(path).connect()).toEqual({ ok: false, reason: "dead" });
  });

  it("the dialer calls a socket nobody listens on dead", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "nm-")), "ptyd.sock");
    const child = spawn(process.execPath, ["-e", `require("node:net").createServer().listen({ path: process.argv[1] }, () => console.log("up"))`, path], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    await new Promise((resolve) => child.stdout.once("data", resolve));
    child.kill("SIGKILL");
    await once(child, "exit");

    expect(await new UnixDaemonDialer(path).connect()).toEqual({ ok: false, reason: "dead" });
  });
});
