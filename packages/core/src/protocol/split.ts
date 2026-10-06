/** No message a Desk process sends is larger than this, encoded. */
export const WIRE_MESSAGE_MAX = 768 * 1024;

/** What a data field may take of a message: the rest (type, pane, part, size fields) gets 4 KiB. */
export const WIRE_DATA_MAX = WIRE_MESSAGE_MAX - 4 * 1024;

/** The largest a single code point gets inside a JSON string: a `\uXXXX` escape. */
const LARGEST_CODE_POINT = 6;

const QUOTES = 2;

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** UTF-8 bytes JSON.stringify writes for one non-surrogate UTF-16 code unit. */
function unitCost(unit: number): number {
  if (unit === 0x22 || unit === 0x5c) return 2; // \" and \\
  if (unit === 0x08 || unit === 0x09 || unit === 0x0a || unit === 0x0c || unit === 0x0d) return 2; // \b \t \n \f \r
  if (unit < 0x20) return 6; // \u00XX, including ESC
  if (unit < 0x80) return 1;
  if (unit < 0x800) return 2; // C1 controls are not escaped: two bytes each
  return 3;
}

/** UTF-16 units and encoded bytes of the code point at `index`: a pair is 4 bytes, a lone surrogate a 6-byte escape. */
function codePointAt(text: string, index: number): { units: 1 | 2; bytes: number } {
  const unit = text.charCodeAt(index);
  if (isHighSurrogate(unit)) {
    return index + 1 < text.length && isLowSurrogate(text.charCodeAt(index + 1))
      ? { units: 2, bytes: 4 }
      : { units: 1, bytes: 6 };
  }
  if (isLowSurrogate(unit)) return { units: 1, bytes: 6 };
  return { units: 1, bytes: unitCost(unit) };
}

/** The UTF-8 length of `JSON.stringify(text)`, quotes included, without building it. */
export function jsonStringBytes(text: string): number {
  let bytes = QUOTES;
  for (let index = 0; index < text.length; ) {
    const point = codePointAt(text, index);
    bytes += point.bytes;
    index += point.units;
  }
  return bytes;
}

/**
 * Splits terminal data so each part, written as a JSON string, takes at most `maxBytes` UTF-8 bytes. Parts end only
 * at code-point boundaries, and joining them gives `data` back. Counting encoded bytes matters because
 * JSON.stringify writes every control character, ESC included, as a 6-byte escape, and terminal output is full of
 * them. Empty data is one empty part. A budget that is not a finite number of at least 8 bytes is a programming error:
 * NaN or Infinity would otherwise return the whole input as one part.
 */
export function splitForWire(data: string, maxBytes: number = WIRE_DATA_MAX): string[] {
  if (!Number.isFinite(maxBytes) || maxBytes < QUOTES + LARGEST_CODE_POINT) {
    throw new RangeError(`splitForWire needs a finite budget of at least ${QUOTES + LARGEST_CODE_POINT} bytes per part`);
  }
  const parts: string[] = [];
  let start = 0;
  let used = QUOTES;
  for (let index = 0; index < data.length; ) {
    const point = codePointAt(data, index);
    if (used + point.bytes > maxBytes) {
      parts.push(data.slice(start, index));
      start = index;
      used = QUOTES;
    }
    used += point.bytes;
    index += point.units;
  }
  parts.push(data.slice(start));
  return parts;
}
