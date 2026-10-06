import { describe, expect, it } from "vitest";
import { NATIVE_FRAME_MAX, NativeFrameDecoder, encodeNativeFrame } from "../src/index.ts";

const MiB = 1024 * 1024;

function bytes(message: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(message));
}

function frameOf(payload: Uint8Array): Uint8Array {
  const result = encodeNativeFrame(payload);
  if (!result.ok) throw new Error("expected a frame");
  return result.frame;
}

/** A frame header announcing `length` bytes, with no payload behind it. */
function header(length: number): Uint8Array {
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, length, true);
  return head;
}

describe("native-messaging codec", () => {
  it("the native-messaging codec round-trips a length-prefixed frame", () => {
    const message = { type: "hello", vMin: 1, vMax: 1, client: "panel", build: "b1", data: "é ✓ 😀 \u001b[0m" };
    const payload = bytes(message);

    const frame = frameOf(payload);
    const decoded = new NativeFrameDecoder().push(frame);

    expect(new DataView(frame.buffer, frame.byteOffset).getUint32(0, true)).toBe(payload.length);
    expect(frame.length).toBe(4 + payload.length);
    expect(decoded).toEqual({ ok: true, frames: [payload] });
    expect(JSON.parse(new TextDecoder().decode(decoded.ok ? decoded.frames[0] : undefined))).toEqual(message);
  });

  it("the native-messaging decoder reassembles frames from any chunking", () => {
    const first = bytes({ type: "in", pane: "p_k2m9q3x7ab", data: "ls\r" });
    const second = bytes({ type: "resize", pane: "p_k2m9q3x7ab", cols: 100, rows: 30 });
    const stream = new Uint8Array([...frameOf(first), ...frameOf(second)]);

    for (let cut = 0; cut <= stream.length; cut += 1) {
      const decoder = new NativeFrameDecoder();
      const a = decoder.push(stream.subarray(0, cut));
      const b = decoder.push(stream.subarray(cut));
      expect([...a.frames, ...b.frames]).toEqual([first, second]);
    }
  });

  it("the native-messaging decoder delivers every frame before an oversized header, whatever the chunking", () => {
    const first = bytes({ type: "in", pane: "p_k2m9q3x7ab", data: "exit\r" });
    const second = bytes({ type: "close", pane: "p_k2m9q3x7ab" });
    const stream = new Uint8Array([...frameOf(first), ...frameOf(second), ...header(2 * MiB)]);

    for (let cut = 0; cut <= stream.length; cut += 1) {
      const decoder = new NativeFrameDecoder();
      const a = decoder.push(stream.subarray(0, cut));
      const b = decoder.push(stream.subarray(cut));
      expect([...a.frames, ...b.frames]).toEqual([first, second]);
      expect(b).toMatchObject({ ok: false, size: 2 * MiB });
    }
  });

  it("the native-messaging decoder copies what it keeps, so a caller may reuse its read buffer", () => {
    const first = bytes({ type: "in", pane: "p_k2m9q3x7ab", data: "ls -la\r" });
    const second = bytes({ type: "resize", pane: "p_k2m9q3x7ab", cols: 120, rows: 40 });
    const stream = new Uint8Array([...frameOf(first), ...frameOf(second)]);
    const readBuffer = new Uint8Array(16);
    const decoder = new NativeFrameDecoder();
    const frames: Uint8Array[] = [];

    for (let at = 0; at < stream.length; at += readBuffer.length) {
      const read = stream.subarray(at, at + readBuffer.length);
      readBuffer.set(read);
      frames.push(...decoder.push(readBuffer.subarray(0, read.length)).frames);
    }

    expect(frames).toEqual([first, second]);
  });

  it("the native-messaging decoder takes linear time for a frame that arrives one byte at a time", () => {
    const payload = new Uint8Array(128 * 1024).fill(0x61);
    const stream = frameOf(payload);
    const decoder = new NativeFrameDecoder();
    const frames: Uint8Array[] = [];

    const started = performance.now();
    for (let at = 0; at < stream.length; at += 1) frames.push(...decoder.push(stream.subarray(at, at + 1)).frames);
    const elapsed = performance.now() - started;

    expect(frames).toEqual([payload]);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("the native-messaging codec refuses a frame over 1 MiB", () => {
    const decoder = new NativeFrameDecoder();

    expect(NATIVE_FRAME_MAX).toBe(MiB);
    expect(decoder.push(header(MiB + 1))).toEqual({ ok: false, size: MiB + 1, frames: [] });
  });

  it("the native-messaging decoder stays refused after an oversized frame", () => {
    const decoder = new NativeFrameDecoder();
    decoder.push(header(2 * MiB));

    expect(decoder.push(frameOf(bytes({ type: "list" })))).toEqual({ ok: false, size: 2 * MiB, frames: [] });
  });

  it("the native-messaging codec accepts a frame of exactly 1 MiB", () => {
    const payload = new Uint8Array(MiB).fill(0x20);

    const result = new NativeFrameDecoder().push(frameOf(payload));

    expect(result.ok && result.frames[0]?.length).toBe(MiB);
  });

  it("the native-messaging encoder refuses a payload over 1 MiB", () => {
    expect(encodeNativeFrame(new Uint8Array(MiB + 1))).toEqual({ ok: false, size: MiB + 1 });
  });
});
