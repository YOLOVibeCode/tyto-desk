/** The longest line the daemon reads, newline excluded (docs/IMPLEMENTATION.md §7.2). */
export const NDJSON_LINE_MAX = 1024 * 1024;

const NEWLINE = 0x0a;

export type LineEncodeResult = { ok: true; line: Uint8Array } | { ok: false; size: number };

/**
 * The complete lines in arrival order, newlines removed. When a line passes 1 MiB, `ok` is false, `size` is how long it
 * had grown, and `lines` still holds the lines that ended before it in the same chunk.
 */
export type LineDecodeResult = { ok: true; lines: Uint8Array[] } | { ok: false; size: number; lines: Uint8Array[] };

/**
 * One NDJSON line: the payload (compact UTF-8 JSON, which never holds a raw newline) and `\n`. Refuses a payload over
 * 1 MiB, and one with a newline, which would split it into two lines. The payload is never parsed.
 */
export function encodeNdjsonLine(payload: Uint8Array): LineEncodeResult {
  if (payload.length > NDJSON_LINE_MAX || payload.includes(NEWLINE)) return { ok: false, size: payload.length };
  const line = new Uint8Array(payload.length + 1);
  line.set(payload);
  line[payload.length] = NEWLINE;
  return { ok: true, line };
}

/**
 * Splits a byte stream into NDJSON lines, whatever the chunking, in time linear in the bytes pushed. It never parses a
 * line, never keeps a reference to a pushed chunk, and every line it returns is its own copy. A line that passes 1 MiB
 * refuses as soon as it does, newline or not, and the decoder stays refused: the caller drops the connection and logs
 * only the size.
 */
export class NdjsonLineDecoder {
  /** The unfinished line, copied out of the chunks it arrived in. */
  private carry = new Uint8Array(0);
  private carried = 0;
  private refusedSize: number | null = null;

  push(chunk: Uint8Array): LineDecodeResult {
    const lines: Uint8Array[] = [];
    if (this.refusedSize !== null) return { ok: false, size: this.refusedSize, lines };
    let start = 0;
    for (let end = chunk.indexOf(NEWLINE); end !== -1; end = chunk.indexOf(NEWLINE, start)) {
      const size = this.carried + (end - start);
      if (size > NDJSON_LINE_MAX) return this.refuse(size, lines);
      if (this.carried === 0) {
        lines.push(chunk.slice(start, end));
      } else {
        const line = new Uint8Array(size);
        line.set(this.carry.subarray(0, this.carried));
        line.set(chunk.subarray(start, end), this.carried);
        lines.push(line);
        this.carried = 0;
      }
      start = end + 1;
    }
    const size = this.carried + (chunk.length - start);
    if (size > NDJSON_LINE_MAX) return this.refuse(size, lines);
    if (start < chunk.length) {
      this.reserve(size);
      this.carry.set(chunk.subarray(start), this.carried);
      this.carried = size;
    }
    return { ok: true, lines };
  }

  /** Room for `size` carried bytes, doubling so a line pushed a byte at a time is copied O(1) times per byte. */
  private reserve(size: number): void {
    if (this.carry.length >= size) return;
    const larger = new Uint8Array(Math.min(NDJSON_LINE_MAX, Math.max(size, this.carry.length * 2, 256)));
    larger.set(this.carry.subarray(0, this.carried));
    this.carry = larger;
  }

  private refuse(size: number, lines: Uint8Array[]): LineDecodeResult {
    this.refusedSize = size;
    this.carry = new Uint8Array(0);
    this.carried = 0;
    return { ok: false, size, lines };
  }
}
