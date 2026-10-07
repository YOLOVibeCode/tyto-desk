const ESC = "\u001b";
const BEL = "\u0007";
/** A tail longer than this is no sequence a terminal would wait for; it is dropped. */
const TAIL_MAX = 64 * 1024;

/** Whether a byte ends a CSI sequence (its final byte, 0x40–0x7E). */
const finalByte = (char: string) => char >= "@" && char <= "~";

/**
 * Follows the shell's output and keeps the escape sequence it is in the middle of, if any (docs/IMPLEMENTATION.md §7.3):
 * a snapshot taken at that point ends with it, so the panel's parser is in the same state as the mirror's when the next
 * output arrives. Knows ESC, CSI, OSC (ended by BEL or ST), DCS, SOS, PM and APC (ended by ST).
 */
export class EscapeTail {
  private pending = "";

  feed(data: string): void {
    let tail = this.pending;
    for (const char of data) {
      if (tail === "") {
        if (char === ESC) tail = ESC;
        continue;
      }
      tail += char;
      if (tail.length > TAIL_MAX) {
        tail = "";
        continue;
      }
      if (tail.length === 2) {
        // ESC + a byte: CSI, a string sequence, an intermediate (ESC ( B …), or a complete two-byte sequence.
        if (char === "[" || char === "]" || char === "P" || char === "X" || char === "^" || char === "_") continue;
        if (char >= " " && char <= "/") continue;
        tail = char === ESC ? ESC : "";
        continue;
      }
      const kind = tail[1];
      if (kind === "[") {
        if (finalByte(char)) tail = "";
      } else if (kind === "]" || kind === "P" || kind === "X" || kind === "^" || kind === "_") {
        if ((kind === "]" && char === BEL) || tail.endsWith(`${ESC}\\`)) tail = "";
      } else if (!(char >= " " && char <= "/")) {
        tail = "";
      }
    }
    this.pending = tail;
  }

  tail(): string {
    return this.pending;
  }
}
