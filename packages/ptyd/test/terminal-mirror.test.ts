import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/headless";
import { NodeTerminalMirror } from "../src/index.ts";

/** The visible lines of a headless terminal, right-trimmed. */
function lines(term: Terminal): string[] {
  const buffer = term.buffer.active;
  const out: string[] = [];
  for (let row = 0; row < term.rows; row += 1) out.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
  return out;
}

describe("the panes' mirrors (docs/IMPLEMENTATION.md §7.3)", () => {
  it("a mirror's snapshot, written into a fresh terminal, shows the same screen", async () => {
    const screen = new NodeTerminalMirror().create(40, 6, 100);
    await screen.write("first line\r\n\u001b[31mred\u001b[0m and plain\r\n");
    await screen.write("prompt % ls");
    await screen.flush();

    const replayed = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
    await new Promise<void>((resolve) => replayed.write(screen.snapshot().data, resolve));

    expect(lines(replayed).slice(0, 3)).toEqual(["first line", "red and plain", "prompt % ls"]);
    screen.dispose();
  });

  it("a mirror says when it shows the alternate screen", async () => {
    const screen = new NodeTerminalMirror().create(40, 6, 100);
    await screen.write("\u001b[?1049hfull screen");
    await screen.flush();
    const inAlternate = screen.snapshot().altScreen;
    await screen.write("\u001b[?1049l");
    await screen.flush();

    expect(inAlternate).toBe(true);
    expect(screen.snapshot().altScreen).toBe(false);
    screen.dispose();
  });

  it("a mirror keeps at most terminal.scrollback lines of scrollback", async () => {
    const screen = new NodeTerminalMirror().create(20, 4, 10);
    for (let i = 0; i < 50; i += 1) await screen.write(`line ${i}\r\n`);
    await screen.flush();

    const replayed = new Terminal({ cols: 20, rows: 4, scrollback: 1000, allowProposedApi: true });
    await new Promise<void>((resolve) => replayed.write(screen.snapshot().data, resolve));

    expect(replayed.buffer.active.length).toBeLessThanOrEqual(4 + 10);
    expect(screen.snapshot().data).toContain("line 49");
    expect(screen.snapshot().data).not.toContain("line 10\r");
    screen.dispose();
  });

  it("flush resolves once every write before it is parsed", async () => {
    // 80 columns × (24 rows + 2,000 lines of scrollback) holds all 100,000 characters.
    const screen = new NodeTerminalMirror().create(80, 24, 2_000);
    void screen.write("a".repeat(100_000));

    await screen.flush();

    expect(screen.snapshot().data.replace(/[^a]/g, "").length).toBe(100_000);
    screen.dispose();
  });
});
