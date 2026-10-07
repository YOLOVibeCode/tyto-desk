import { EscapeTail } from "./escape-tail.ts";

const ESC = "\u001b";

/**
 * The terminal modes addon-serialize does not write (docs/IMPLEMENTATION.md §7.3): SGR mouse encoding (1006) and SGR
 * pixel mouse encoding (1016), cursor visibility (25), and the cursor style (DECSCUSR). It reads them from the shell's
 * output, sequences split across chunks included, and replays whatever differs from a fresh terminal.
 */
export class ModeTracker {
  private readonly split = new EscapeTail();
  private sgrMouse = false;
  private sgrPixels = false;
  private cursorHidden = false;
  private cursorStyle = 0;

  feed(data: string): void {
    const text = this.split.tail() + data;
    this.split.feed(data);
    for (const match of text.matchAll(/\u001b\[\?([\d;]+)([hl])|\u001b\[(\d*) q/g)) {
      if (match[3] !== undefined) {
        this.cursorStyle = Number(match[3] === "" ? 0 : match[3]);
        continue;
      }
      const on = match[2] === "h";
      for (const mode of (match[1] ?? "").split(";")) {
        if (mode === "1006") this.sgrMouse = on;
        else if (mode === "1016") this.sgrPixels = on;
        else if (mode === "25") this.cursorHidden = !on;
      }
    }
  }

  replay(): string {
    let modes = "";
    if (this.sgrMouse) modes += `${ESC}[?1006h`;
    if (this.sgrPixels) modes += `${ESC}[?1016h`;
    if (this.cursorHidden) modes += `${ESC}[?25l`;
    if (this.cursorStyle !== 0) modes += `${ESC}[${this.cursorStyle} q`;
    return modes;
  }
}
