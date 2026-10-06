import { describe, expect, it } from "vitest";
import { WIRE_DATA_MAX, WIRE_MESSAGE_MAX, jsonStringBytes, splitForWire } from "../src/index.ts";

const KiB = 1024;

function repeat(unit: string, chars: number): string {
  return unit.repeat(Math.ceil(chars / unit.length));
}

/** Terminal-like content, several megabytes each, built to cost the most per character once JSON-encoded. */
const contents: Array<[string, string]> = [
  ["ESC sequences", repeat("\u001b[38;5;196m\u001b[0m\u001b]0;title\u0007", 2_000_000)],
  ["C1 controls", repeat("\u0080\u0085\u008d\u009b\u009d\u009f", 2_000_000)],
  ["lone surrogates", repeat("𐏿x\udbff", 2_000_000)],
  [
    "a mix with pairs, quotes and line separators",
    repeat('\u001b[1m"quoted\\path"\u0000\u007f\u0090😀中文 \ud800\r\n\t', 2_000_000),
  ],
];

function snapshotMessages(data: string): string[] {
  const parts = splitForWire(data);
  return parts.map((part, index) =>
    JSON.stringify({
      type: "snapshot",
      pane: "p_k2m9q3x7ab",
      part: index,
      last: index === parts.length - 1,
      cols: 500,
      rows: 200,
      data: part,
    }),
  );
}

describe("splitForWire", () => {
  it.each(contents)(
    "splitForWire keeps every message within 768 KiB encoded for ESC, C1 and lone-surrogate content (%s)",
    (_kind, data) => {
      const messages = snapshotMessages(data);

      expect(WIRE_MESSAGE_MAX).toBe(768 * KiB);
      expect(messages.length).toBeGreaterThan(1);
      for (const message of messages) expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(768 * KiB);
    },
  );

  it.each(contents)("splitForWire loses and reorders nothing (%s)", (_kind, data) => {
    expect(splitForWire(data).join("")).toBe(data);
  });

  it("splitForWire never splits a surrogate pair", () => {
    const data = repeat("a😀", 1_000_000);

    for (const part of splitForWire(data, 1_001)) {
      expect(part.charCodeAt(part.length - 1)).not.toBe(0xd83d);
      expect(part.charCodeAt(0)).not.toBe(0xde00);
    }
  });

  it("splitForWire fills each part to within one character of the budget", () => {
    const parts = splitForWire(contents[3]?.[1] ?? "", 10_000);

    for (const part of parts.slice(0, -1)) expect(jsonStringBytes(part)).toBeGreaterThan(10_000 - 6);
  });

  it("splitForWire returns one empty part for empty data", () => {
    expect(splitForWire("")).toEqual([""]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 7, 0, -1])(
    "splitForWire refuses a budget of %s bytes per part",
    (maxBytes) => {
      expect(() => splitForWire("\u001b[0m".repeat(100), maxBytes)).toThrow(RangeError);
    },
  );

  it("splitForWire leaves room for the rest of the message", () => {
    expect(WIRE_DATA_MAX).toBeLessThanOrEqual(WIRE_MESSAGE_MAX - KiB);
  });

  it("jsonStringBytes counts the bytes JSON.stringify writes", () => {
    let seed = 7;
    for (let round = 0; round < 200; round += 1) {
      let text = "";
      for (let i = 0; i < 64; i += 1) {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        text += String.fromCharCode(seed % 0x10000);
      }
      expect(jsonStringBytes(text)).toBe(Buffer.byteLength(JSON.stringify(text), "utf8"));
    }
  });
});
