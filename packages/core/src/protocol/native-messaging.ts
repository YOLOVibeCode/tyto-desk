/** Chrome caps host-to-Chrome messages at 1 MB; Desk's host drops any frame over 1 MiB in either direction. */
export const NATIVE_FRAME_MAX = 1024 * 1024;

const HEADER = 4;

export type EncodeResult = { ok: true; frame: Uint8Array } | { ok: false; size: number };

/** Complete payloads in arrival order, or the announced size of the frame that ended the connection. */
export type DecodeResult = { ok: true; frames: Uint8Array[] } | { ok: false; size: number };

/** Chrome native messaging: a 4-byte little-endian length, then the payload (UTF-8 JSON, which Desk never parses). */
export function encodeNativeFrame(payload: Uint8Array): EncodeResult {
  if (payload.length > NATIVE_FRAME_MAX) return { ok: false, size: payload.length };
  const frame = new Uint8Array(HEADER + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length, true);
  frame.set(payload, HEADER);
  return { ok: true, frame };
}

/**
 * Splits a byte stream into native-messaging payloads, whatever the chunking. A header announcing more than 1 MiB
 * refuses at once, before any of its payload is buffered, and the decoder stays refused: the caller drops the
 * connection and logs only the size.
 */
export class NativeFrameDecoder {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private refused: { ok: false; size: number } | null = null;

  push(chunk: Uint8Array): DecodeResult {
    if (this.refused) return this.refused;
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    const frames: Uint8Array[] = [];
    while (this.buffered >= HEADER) {
      const head = this.peek(HEADER);
      const length = new DataView(head.buffer).getUint32(0, true);
      if (length > NATIVE_FRAME_MAX) {
        this.refused = { ok: false, size: length };
        this.chunks = [];
        this.buffered = 0;
        return this.refused;
      }
      if (this.buffered < HEADER + length) break;
      this.take(HEADER);
      frames.push(this.take(length));
    }
    return { ok: true, frames };
  }

  /** A copy of the first `n` buffered bytes; `n` must not exceed what is buffered. */
  private peek(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    for (const chunk of this.chunks) {
      if (filled === n) break;
      const part = chunk.subarray(0, n - filled);
      out.set(part, filled);
      filled += part.length;
    }
    return out;
  }

  /** Removes and returns the first `n` buffered bytes; `n` must not exceed what is buffered. */
  private take(n: number): Uint8Array {
    const out = this.peek(n);
    let remaining = n;
    while (remaining > 0) {
      const first = this.chunks[0];
      if (first === undefined) break;
      if (first.length <= remaining) {
        this.chunks.shift();
        remaining -= first.length;
      } else {
        this.chunks[0] = first.subarray(remaining);
        remaining = 0;
      }
    }
    this.buffered -= n;
    return out;
  }
}
