import { describe, expect, it } from "vitest";
import { linkTarget, osc52Write, tabTitle } from "../src/index.ts";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("what programs print that the panel acts on (docs/IMPLEMENTATION.md §10)", () => {
  it("a title containing markup renders as text, cut at 200 characters", () => {
    const title = tabTitle(`<b onclick="x()">${"t".repeat(300)}</b>`);

    expect(title).toHaveLength(200);
    expect(title?.startsWith('<b onclick="x()">')).toBe(true);
  });

  it("a title loses its control characters and surrounding blanks, and an empty one is no title", () => {
    expect(tabTitle("  vim\u0007 \u001b[1mmain.ts\u0000  ")).toBe("vim [1mmain.ts");
    expect(tabTitle(" \u0007 ")).toBeNull();
  });

  it.each([
    ["https://example.test/a?b=1", true, "https://example.test/a?b=1"],
    ["http://localhost:3000/", true, "http://localhost:3000/"],
    ["https://example.test/", false, null],
    ["javascript:alert(1)", true, null],
    ["file:///etc/passwd", true, null],
    ["chrome://settings", true, null],
    ["data:text/html,hi", true, null],
    ["chrome-extension://abc/panel.html", true, null],
    ["not a url", true, null],
  ])("only http and https links open, on Cmd+click, as a new Desk tab: %s with Cmd %s opens %s", (uri, meta, opened) => {
    expect(linkTarget(uri, { meta })).toBe(opened);
  });

  it("OSC 52 reads are ignored and writes need osc52Write", () => {
    expect(osc52Write(`c;${b64("copied ✓")}`, true)).toBe("copied ✓");
    expect(osc52Write(`c;${b64("copied")}`, false)).toBeNull();
    expect(osc52Write("c;?", true)).toBeNull();
    expect(osc52Write("?", true)).toBeNull();
  });

  it("OSC 52 ignores a payload that is not base64, or one over 1 MiB", () => {
    expect(osc52Write("c;not base64!", true)).toBeNull();
    expect(osc52Write(`c;${"A".repeat(2 ** 20 * 2)}`, true)).toBeNull();
  });
});

describe("UTF-8 without TextDecoder", () => {
  it.each([
    ["ascii", "plain"],
    ["two, three and four bytes", "é ✓ 你好 🦉"],
  ])("utf8Decode reads %s as TextDecoder does", async (_, text) => {
    const { utf8Decode } = await import("../src/bytes/utf8-decode.ts");

    expect(utf8Decode(new TextEncoder().encode(text))).toBe(text);
  });

  it.each([
    ["a lone continuation byte", [0x80], "�"],
    ["a truncated sequence", [0xe4, 0xbd], "�"],
    ["an overlong encoding", [0xc0, 0xaf], "��"],
    ["a surrogate", [0xed, 0xa0, 0x80], "�"],
  ])("utf8Decode replaces %s", async (_, bytes, text) => {
    const { utf8Decode } = await import("../src/bytes/utf8-decode.ts");

    expect(utf8Decode(Uint8Array.from(bytes))).toBe(text);
  });
});
