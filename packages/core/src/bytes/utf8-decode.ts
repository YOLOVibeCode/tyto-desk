/**
 * UTF-8 bytes as text (core has no `TextDecoder`): a malformed or overlong sequence, a surrogate, or a code point past
 * U+10FFFF becomes U+FFFD, as the WHATWG decoder's replacement mode does for each maximal bad subpart.
 */
export function utf8Decode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const first = bytes[i] ?? 0;
    const need = first < 0x80 ? 0 : first >= 0xc2 && first <= 0xdf ? 1 : first >= 0xe0 && first <= 0xef ? 2 : first >= 0xf0 && first <= 0xf4 ? 3 : -1;
    if (need < 0) {
      out += "�";
      i += 1;
      continue;
    }
    let code = need === 0 ? first : first & (0xff >> (need + 2));
    let used = 1;
    for (; used <= need; used += 1) {
      const next = bytes[i + used];
      if (next === undefined || (next & 0xc0) !== 0x80) break;
      code = (code << 6) | (next & 0x3f);
    }
    const complete = used === need + 1;
    const min = [0, 0x80, 0x800, 0x10000][need] ?? 0;
    if (!complete || code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      out += "�";
      i += Math.max(1, used);
      continue;
    }
    out += String.fromCodePoint(code);
    i += used;
  }
  return out;
}
