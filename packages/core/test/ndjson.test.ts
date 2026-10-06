import { describe, expect, it } from "vitest";
import { NDJSON_LINE_MAX, NdjsonLineDecoder, encodeNdjsonLine } from "../src/index.ts";

const MiB = 1024 * 1024;

function bytes(message: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(message));
}

function lineOf(payload: Uint8Array): Uint8Array {
  const result = encodeNdjsonLine(payload);
  if (!result.ok) throw new Error("expected a line");
  return result.line;
}

describe("NDJSON line codec", () => {
  it("the NDJSON codec round-trips a line", () => {
    const message = { type: "out", pane: "p_k2m9q3x7ab", data: "é ✓ 😀 \u001b[0m\r\n" };
    const payload = bytes(message);

    const line = lineOf(payload);

    expect(line).toEqual(new Uint8Array([...payload, 0x0a]));
    expect(new NdjsonLineDecoder().push(line)).toEqual({ ok: true, lines: [payload] });
  });

  it("the NDJSON decoder splits lines from any chunking", () => {
    const first = bytes({ type: "hello", vMin: 1, vMax: 1, client: "panel", build: "b1" });
    const second = bytes({ type: "list", id: "r_0000000001" });
    const stream = new Uint8Array([...lineOf(first), ...lineOf(second)]);

    for (let cut = 0; cut <= stream.length; cut += 1) {
      const decoder = new NdjsonLineDecoder();
      const a = decoder.push(stream.subarray(0, cut));
      const b = decoder.push(stream.subarray(cut));
      expect([...a.lines, ...b.lines]).toEqual([first, second]);
    }
  });

  it("the NDJSON codec refuses a line over 1 MiB and reports only its size", () => {
    const decoder = new NdjsonLineDecoder();

    expect(NDJSON_LINE_MAX).toBe(MiB);
    expect(decoder.push(new Uint8Array(MiB + 1).fill(0x20))).toEqual({ ok: false, size: MiB + 1, lines: [] });
  });

  it("the NDJSON decoder refuses a long line as soon as it passes 1 MiB, before its newline arrives", () => {
    const decoder = new NdjsonLineDecoder();
    const half = new Uint8Array(MiB / 2).fill(0x20);

    expect(decoder.push(half)).toEqual({ ok: true, lines: [] });
    expect(decoder.push(half)).toEqual({ ok: true, lines: [] });
    expect(decoder.push(new Uint8Array([0x20]))).toEqual({ ok: false, size: MiB + 1, lines: [] });
  });

  it("the NDJSON codec accepts a line of exactly 1 MiB", () => {
    const payload = new Uint8Array(MiB).fill(0x20);

    const result = new NdjsonLineDecoder().push(lineOf(payload));

    expect(result.ok && result.lines[0]?.length).toBe(MiB);
  });

  it("the NDJSON decoder stays refused after an over-long line", () => {
    const decoder = new NdjsonLineDecoder();
    decoder.push(new Uint8Array(MiB + 1).fill(0x20));

    expect(decoder.push(lineOf(bytes({ type: "list" })))).toEqual({ ok: false, size: MiB + 1, lines: [] });
  });

  it("the NDJSON decoder delivers every line before an over-long one, whatever the chunking", () => {
    const first = bytes({ type: "in", pane: "p_k2m9q3x7ab", data: "exit\r" });
    const second = bytes({ type: "close", pane: "p_k2m9q3x7ab" });
    const stream = new Uint8Array([...lineOf(first), ...lineOf(second), ...new Uint8Array(MiB + 1).fill(0x20)]);

    for (const cut of [0, 1, first.length, first.length + 1, first.length + second.length + 2, stream.length]) {
      const decoder = new NdjsonLineDecoder();
      const a = decoder.push(stream.subarray(0, cut));
      const b = decoder.push(stream.subarray(cut));
      expect([...a.lines, ...b.lines]).toEqual([first, second]);
      expect(b).toMatchObject({ ok: false, size: MiB + 1 });
    }
  });

  it("the NDJSON decoder copies what it keeps, so a caller may reuse its read buffer", () => {
    const first = bytes({ type: "in", pane: "p_k2m9q3x7ab", data: "ls -la\r" });
    const second = bytes({ type: "resize", pane: "p_k2m9q3x7ab", cols: 120, rows: 40 });
    const stream = new Uint8Array([...lineOf(first), ...lineOf(second)]);
    const readBuffer = new Uint8Array(16);
    const decoder = new NdjsonLineDecoder();
    const lines: Uint8Array[] = [];

    for (let at = 0; at < stream.length; at += readBuffer.length) {
      const read = stream.subarray(at, at + readBuffer.length);
      readBuffer.set(read);
      lines.push(...decoder.push(readBuffer.subarray(0, read.length)).lines);
    }

    expect(lines).toEqual([first, second]);
  });

  it("the NDJSON decoder takes linear time for a line that arrives one byte at a time", () => {
    const payload = new Uint8Array(128 * 1024).fill(0x61);
    const stream = lineOf(payload);
    const decoder = new NdjsonLineDecoder();
    const lines: Uint8Array[] = [];

    const started = performance.now();
    for (let at = 0; at < stream.length; at += 1) lines.push(...decoder.push(stream.subarray(at, at + 1)).lines);
    const elapsed = performance.now() - started;

    expect(lines).toEqual([payload]);
    expect(elapsed).toBeLessThan(2_000);
  });

  it.each([
    ["over 1 MiB", new Uint8Array(MiB + 1).fill(0x20), MiB + 1],
    ["with a newline, which would split it", new TextEncoder().encode('{"a":\n1}'), 8],
  ])("the NDJSON encoder refuses a payload %s", (_label, payload, size) => {
    expect(encodeNdjsonLine(payload)).toEqual({ ok: false, size });
  });
});
