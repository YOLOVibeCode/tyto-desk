import type { Socket } from "node:net";
import { NativeFrameDecoder, NdjsonLineDecoder, encodeNativeFrame, encodeNdjsonLine } from "@desk/core";

/**
 * The host's relay (docs/IMPLEMENTATION.md §8): each native message from Chrome becomes one NDJSON line to the daemon,
 * and each daemon line one native message, both through core's codecs and never parsed. A frame or line over 1 MiB
 * ends both connections (exit 1), after the host tells the panel it dropped one (`{type: "host", state: "dropped"}`). Chrome closing stdin ends the daemon connection (exit 0); the daemon going away ends
 * the host (exit 0), which Chrome sees as a disconnect.
 */
export function relay(io: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; socket: Socket }): Promise<number> {
  const { stdin, stdout, socket } = io;
  const frames = new NativeFrameDecoder();
  const lines = new NdjsonLineDecoder();
  return new Promise((resolve) => {
    let finished = false;
    const dropped = () => {
      const report = encodeNativeFrame(new TextEncoder().encode(JSON.stringify({ type: "host", state: "dropped" })));
      if (report.ok) stdout.write(report.frame);
    };
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      if (code === 1) dropped();
      stdin.removeAllListeners("data");
      if (code === 0) socket.end();
      else socket.destroy();
      resolve(code);
    };
    stdin.on("data", (chunk: Buffer) => {
      const decoded = frames.push(chunk);
      for (const payload of decoded.frames) {
        const line = encodeNdjsonLine(payload);
        if (!line.ok) {
          finish(1);
          return;
        }
        socket.write(line.line);
      }
      if (!decoded.ok) finish(1);
    });
    stdin.on("end", () => finish(0));
    socket.on("data", (chunk: Buffer) => {
      const decoded = lines.push(chunk);
      for (const line of decoded.lines) {
        const message = encodeNativeFrame(line);
        if (!message.ok) {
          finish(1);
          return;
        }
        stdout.write(message.frame);
      }
      if (!decoded.ok) finish(1);
    });
    socket.on("error", () => undefined);
    socket.on("close", () => finish(0));
  });
}
