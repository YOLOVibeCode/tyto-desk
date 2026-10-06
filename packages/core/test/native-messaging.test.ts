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
      const frames = [...(a.ok ? a.frames : []), ...(b.ok ? b.frames : [])];
      expect(frames).toEqual([first, second]);
    }
  });

  it("the native-messaging codec refuses a frame over 1 MiB", () => {
    const decoder = new NativeFrameDecoder();

    expect(NATIVE_FRAME_MAX).toBe(MiB);
    expect(decoder.push(header(MiB + 1))).toEqual({ ok: false, size: MiB + 1 });
  });

  it("the native-messaging decoder stays refused after an oversized frame", () => {
    const decoder = new NativeFrameDecoder();
    decoder.push(header(2 * MiB));

    expect(decoder.push(frameOf(bytes({ type: "list" })))).toEqual({ ok: false, size: 2 * MiB });
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
