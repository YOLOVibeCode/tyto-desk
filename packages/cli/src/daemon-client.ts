import { connect, type Socket } from "node:net";
import {
  NdjsonLineDecoder,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  encodeNdjsonLine,
  parseDaemonMessage,
  type DaemonClient,
  type DaemonMessage,
  type DaemonNotice,
  type DaemonOpen,
  type DaemonRequest,
} from "@desk/core";
import { assertPathAllowed } from "@desk/node";

/** §6.6: the hello handshake and an ext.call round trip take 2 s each; a reply gets a little more than the daemon's own. */
const HELLO_MS = 2_000;
const REPLY_MS = 3_000;

function connectTo(path: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = connect({ path });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, HELLO_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/**
 * The daemon as a client of kind `cli` or `watch` sees it (docs/IMPLEMENTATION.md §3 `DaemonClient`): a connection to
 * `run/ptyd.sock`, hello, then requests whose replies are matched by id. Every line it reads passes core's codecs.
 */
export class UnixDaemonClient implements DaemonClient {
  private readonly path: string;
  private readonly build: string;

  constructor(path: string, build: string) {
    this.path = path;
    this.build = build;
  }

  async open(kind: "cli" | "watch"): Promise<DaemonOpen> {
    await assertPathAllowed(this.path);
    const socket = await connectTo(this.path);
    if (socket === null) return { ok: false, reason: "unreachable" };
    const encoder = new TextEncoder();
    const text = new TextDecoder("utf-8");
    const decoder = new NdjsonLineDecoder();
    const waiting = new Map<string, (message: DaemonMessage | null) => void>();
    let helloReply: (message: DaemonMessage | null) => void = () => undefined;
    const send = (message: Record<string, unknown>) => {
      const line = encodeNdjsonLine(encoder.encode(JSON.stringify(message)));
      if (line.ok) socket.write(line.line);
    };
    const settleAll = () => {
      helloReply(null);
      for (const resolve of waiting.values()) resolve(null);
      waiting.clear();
    };
    socket.on("data", (chunk: Buffer) => {
      const decoded = decoder.push(chunk);
      for (const line of decoded.lines) {
        let raw: unknown;
        try {
          raw = JSON.parse(text.decode(line));
        } catch {
          continue;
        }
        const message = parseDaemonMessage(raw);
        if (message === null) continue;
        if (message.type === "hello" || (message.type === "error" && message.code === "E_STALE")) {
          helloReply(message);
          continue;
        }
        const id = "id" in message ? message.id : undefined;
        const resolve = id === undefined ? undefined : waiting.get(id);
        if (id !== undefined && resolve !== undefined) {
          waiting.delete(id);
          resolve(message);
        }
      }
      if (!decoded.ok) socket.destroy();
    });
    socket.on("error", () => undefined);
    socket.on("close", settleAll);

    const hello = await new Promise<DaemonMessage | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), HELLO_MS);
      helloReply = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
      send({ type: "hello", vMin: PROTOCOL_MIN, vMax: PROTOCOL_MAX, client: kind, build: this.build });
    });
    helloReply = () => undefined;
    if (hello === null || hello.type !== "hello") {
      socket.destroy();
      return { ok: false, reason: hello?.type === "error" ? "stale" : "unreachable" };
    }
    let next = 0;
    return {
      ok: true,
      session: {
        request: (message: DaemonRequest) =>
          new Promise<DaemonMessage | null>((resolve) => {
            if (socket.destroyed) {
              resolve(null);
              return;
            }
            next += 1;
            const id = `c${next}`;
            const timer = setTimeout(() => {
              waiting.delete(id);
              resolve(null);
            }, REPLY_MS);
            waiting.set(id, (reply) => {
              clearTimeout(timer);
              resolve(reply);
            });
            send({ ...message, id });
          }),
        notify: (message: DaemonNotice) =>
          new Promise<void>((resolve) => {
            const line = encodeNdjsonLine(encoder.encode(JSON.stringify(message)));
            if (socket.destroyed || !line.ok) {
              resolve();
              return;
            }
            socket.write(line.line, () => resolve());
          }),
        close: () => {
          socket.end();
        },
      },
    };
  }
}
