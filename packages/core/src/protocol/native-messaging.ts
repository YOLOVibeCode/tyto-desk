/** Chrome caps host-to-Chrome messages at 1 MB; Desk's host drops any frame over 1 MiB in either direction. */
export const NATIVE_FRAME_MAX = 1024 * 1024;

const HEADER = 4;

export type EncodeResult = { ok: true; frame: Uint8Array } | { ok: false; size: number };

/**
 * The complete payloads in arrival order. When a header announces more than 1 MiB, `ok` is false, `size` is what it
 * announced, and `frames` still holds the payloads that arrived before it in the same chunk.
 */
export type DecodeResult = { ok: true; frames: Uint8Array[] } | { ok: false; size: number; frames: Uint8Array[] };

/** Chrome native messaging: a 4-byte little-endian length, then the payload (UTF-8 JSON, which Desk never parses). */
export function encodeNativeFrame(payload: Uint8Array): EncodeResult {
  if (payload.length > NATIVE_FRAME_MAX) return { ok: false, size: payload.length };
  const frame = new Uint8Array(HEADER + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length, true);
  frame.set(payload, HEADER);
  return { ok: true, frame };
}

function lengthAt(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, HEADER).getUint32(0, true);
}

/**
 * Splits a byte stream into native-messaging payloads, whatever the chunking, in time linear in the bytes pushed.
 * It never keeps a reference to a pushed chunk (a caller may reuse its read buffer), and every payload it returns is
 * its own copy. A header announcing more than 1 MiB refuses at once, before any of its payload is buffered, and the
 * decoder stays refused: the caller drops the connection and logs only the size.
 */
export class NativeFrameDecoder {
  /** The unfinished frame, header included, copied out of the chunks it arrived in. */
  private carry = new Uint8Array(HEADER);
  private carried = 0;
  private refusedSize: number | null = null;

  push(chunk: Uint8Array): DecodeResult {
    const frames: Uint8Array[] = [];
    if (this.refusedSize !== null) return { ok: false, size: this.refusedSize, frames };
    let offset = 0;

    if (this.carried > 0) {
      offset = this.fill(chunk, offset, HEADER);
      if (this.carried < HEADER) return { ok: true, frames };
      const length = lengthAt(this.carry, 0);
      if (length > NATIVE_FRAME_MAX) return this.refuse(length, frames);
      offset = this.fill(chunk, offset, HEADER + length);
      if (this.carried < HEADER + length) return { ok: true, frames };
      frames.push(this.carry.slice(HEADER, HEADER + length));
      this.carried = 0;
    }

    while (chunk.length - offset >= HEADER) {
      const length = lengthAt(chunk, offset);
      if (length > NATIVE_FRAME_MAX) return this.refuse(length, frames);
      if (chunk.length - offset < HEADER + length) break;
      frames.push(chunk.slice(offset + HEADER, offset + HEADER + length));
      offset += HEADER + length;
    }

    const rest = chunk.length - offset;
    if (rest > 0) {
      this.reserve(rest >= HEADER ? HEADER + lengthAt(chunk, offset) : HEADER);
      this.carry.set(chunk.subarray(offset), 0);
      this.carried = rest;
    }
    return { ok: true, frames };
  }

  /** Copies bytes from `chunk[offset…]` until the carry holds `upTo` bytes or the chunk ends; returns the new offset. */
  private fill(chunk: Uint8Array, offset: number, upTo: number): number {
    this.reserve(upTo);
    const take = Math.min(upTo - this.carried, chunk.length - offset);
    if (take <= 0) return offset;
    this.carry.set(chunk.subarray(offset, offset + take), this.carried);
    this.carried += take;
    return offset + take;
  }

  /** Room for `size` carried bytes; at most 4 bytes plus 1 MiB, since longer frames are refused first. */
  private reserve(size: number): void {
    if (this.carry.length >= size) return;
    const larger = new Uint8Array(size);
    larger.set(this.carry.subarray(0, this.carried));
    this.carry = larger;
  }

  private refuse(size: number, frames: Uint8Array[]): DecodeResult {
    this.refusedSize = size;
    this.carry = new Uint8Array(0);
    this.carried = 0;
    return { ok: false, size, frames };
  }
}
