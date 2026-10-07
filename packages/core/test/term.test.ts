import { describe, expect, it } from "vitest";
import { EscapeTail, ModeTracker, sanitizePaste } from "../src/index.ts";

const ESC = "\u001b";

describe("pasting into the terminal (docs/IMPLEMENTATION.md §10)", () => {
  it("sanitizePaste removes ESC, C1 and C0 controls except tab, CR and LF", () => {
    const pasted = `a\tb\r\nc${ESC}[31md\u0007e\u0000f\u0085g\u009bh\u007fi`;

    expect(sanitizePaste(pasted)).toBe("a\tb\r\nc[31mdefghi");
  });

  it("sanitizePaste leaves text without controls as it is", () => {
    expect(sanitizePaste("ls -la ~/Dev && echo \"done\" ✓")).toBe("ls -la ~/Dev && echo \"done\" ✓");
  });
});

describe("the unfinished escape sequence at the flush point (docs/IMPLEMENTATION.md §7.3)", () => {
  it.each([
    ["a lone ESC", `text${ESC}`, ESC],
    ["a CSI without its final byte", `text${ESC}[38;5;2`, `${ESC}[38;5;2`],
    ["an OSC without its terminator", `x${ESC}]0;title so far`, `${ESC}]0;title so far`],
    ["a DCS without ST", `x${ESC}Pq#0;2;0;0;0`, `${ESC}Pq#0;2;0;0;0`],
    ["a finished CSI", `x${ESC}[0m`, ""],
    ["an OSC ended by BEL", `x${ESC}]0;done\u0007`, ""],
    ["an OSC ended by ST", `x${ESC}]0;done${ESC}\\`, ""],
    ["plain text", "just text\r\n", ""],
  ])("EscapeTail keeps %s", (_, stream, tail) => {
    const tracker = new EscapeTail();

    tracker.feed(stream);

    expect(tracker.tail()).toBe(tail);
  });

  it("EscapeTail follows a sequence split across chunks", () => {
    const tracker = new EscapeTail();

    tracker.feed(`a${ESC}[3`);
    const middle = tracker.tail();
    tracker.feed("1m");

    expect(middle).toBe(`${ESC}[3`);
    expect(tracker.tail()).toBe("");
  });
});

describe("the modes serialize does not write (docs/IMPLEMENTATION.md §7.3)", () => {
  it("a snapshot replays mouse encoding, cursor visibility and cursor style", () => {
    const modes = new ModeTracker();

    modes.feed(`${ESC}[?1006h${ESC}[?25l${ESC}[5 q`);

    expect(modes.replay()).toBe(`${ESC}[?1006h${ESC}[?25l${ESC}[5 q`);
  });

  it("ModeTracker replays nothing for a terminal in its default modes", () => {
    const modes = new ModeTracker();

    modes.feed(`${ESC}[?1006h${ESC}[?1006l${ESC}[?25l${ESC}[?25h${ESC}[3 q${ESC}[0 q`);

    expect(modes.replay()).toBe("");
  });

  it("ModeTracker follows a mode switch split across chunks", () => {
    const modes = new ModeTracker();

    modes.feed(`${ESC}[?10`);
    modes.feed("16h");

    expect(modes.replay()).toBe(`${ESC}[?1016h`);
  });
});
