import { base64Decode } from "../bytes/base64.ts";
import { sha256 } from "../bytes/sha256.ts";

/** Chrome writes each of the first 32 hex digits of the digest as a letter: 0 is `a`, f is `p`. */
const LETTER_A = 0x61;

/**
 * The id Chrome gives an extension whose manifest has this `key` (base64 of the DER SubjectPublicKeyInfo): the first
 * 128 bits of the key's SHA-256, one letter from a to p per hex digit. The key must be bare, strict base64, which is
 * what Desk writes into its manifest. Chrome also strips PEM armor from a manifest key; Desk never writes one, so a
 * PEM-armored key throws here, as does anything else that is not strict base64 (`base64Decode`).
 */
export function extensionIdFromKey(key: string): string {
  const der = key.length === 0 ? null : base64Decode(key);
  if (der === null) throw new TypeError("the manifest key is not strict base64");
  let id = "";
  for (const byte of sha256(der).subarray(0, 16)) {
    id += String.fromCharCode(LETTER_A + (byte >>> 4), LETTER_A + (byte & 0x0f));
  }
  return id;
}
