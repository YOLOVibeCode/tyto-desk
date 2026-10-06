const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const VALUES = new Map<string, number>([...ALPHABET].map((char, value) => [char, value]));

/**
 * Strict RFC 4648 base64, as Chrome reads a manifest `key`: the standard alphabet, padding to a multiple of four,
 * no whitespace. Returns `null` for anything else.
 */
export function base64Decode(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const body = text.slice(0, text.length - padding);
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let bits = 0;
  let count = 0;
  let index = 0;
  for (const char of body) {
    const value = VALUES.get(char);
    if (value === undefined) return null;
    bits = (bits << 6) | value;
    count += 6;
    if (count >= 8) {
      count -= 8;
      out[index] = (bits >>> count) & 0xff;
      index += 1;
    }
  }
  return index === out.length ? out : null;
}
