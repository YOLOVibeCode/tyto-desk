import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkExtensionSource, extensionViolations } from "../scripts/lib/extension-lint.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));

describe("lint:extension (docs/IMPLEMENTATION.md §9)", () => {
  it("the extension never uses innerHTML, eval or chrome.debugger.attach", async () => {
    expect(await extensionViolations(join(repo, "packages", "extension"))).toEqual([]);
  });

  it.each([
    ["chrome.debugger.attach", "chrome.debugger.attach({ tabId: 1 }, '1.3');"],
    ["chrome.debugger.sendCommand", "await chrome.debugger.sendCommand({ tabId: 1 }, 'Runtime.evaluate');"],
    ["chrome.debugger.detach", "chrome.debugger.detach({ tabId: 1 });"],
    ["a debugger method reached by an element access", 'chrome.debugger["attach"]({ tabId: 1 });'],
    ["innerHTML", "element.innerHTML = title;"],
    ["outerHTML", "const html = element.outerHTML;"],
    ["insertAdjacentHTML", "element.insertAdjacentHTML('beforeend', title);"],
    ["document.write", "document.write(title);"],
    ["document.writeln", "document.writeln(title);"],
    ["eval", "eval(code);"],
    ["Function(", "const run = Function('return 1');"],
    ["new Function(", "const run = new Function('return 1');"],
    ["a node: import", 'import { readFile } from "node:fs/promises";'],
    ["a Node builtin by its bare name", 'import fs from "fs";'],
    ["a dynamic node: import", 'await import("node:child_process");'],
  ])("lint:extension refuses %s", (_label, text) => {
    expect(checkExtensionSource(text, "src/panel.ts").length).toBeGreaterThan(0);
  });

  it.each([
    ["textContent", "banner.textContent = title;"],
    ["chrome.debugger.getTargets", "const targets = await chrome.debugger.getTargets();"],
    ["a method that is only named like eval", "const evaluate = () => 1; evaluate();"],
    ["the words in a comment", "// innerHTML, eval and chrome.debugger.attach are banned"],
    ["the words in a string", 'const banned = "innerHTML eval chrome.debugger.attach";'],
    ["xterm", 'import { Terminal } from "@xterm/xterm";'],
  ])("lint:extension accepts %s", (_label, text) => {
    expect(checkExtensionSource(text, "src/panel.ts")).toEqual([]);
  });

  it.each([
    ["convertEol true", "new Terminal({ convertEol: true, scrollback: 5000 });"],
    ["no convertEol", "new Terminal({ scrollback: 5000 });"],
    ["windowOptions", "new Terminal({ convertEol: false, windowOptions: { getWinTitle: true } });"],
    ["options it cannot read", "new Terminal(options);"],
  ])("the panel's xterm keeps convertEol false and windowOptions at their defaults: lint:extension refuses %s", (_label, text) => {
    expect(checkExtensionSource(text, "src/xterm-view.ts")).toEqual([{ file: "src/xterm-view.ts", line: 1, rule: "xterm options" }]);
  });

  it("lint:extension accepts an xterm with convertEol false", () => {
    expect(checkExtensionSource("new Terminal({ convertEol: false, scrollback: 5000 });", "src/xterm-view.ts")).toEqual([]);
  });

  it("lint:extension reports the file and line, never the source", async () => {
    const root = await mkdtemp(join(tmpdir(), "extension-lint-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "panel.ts"), "const a = 1;\nelement.innerHTML = secretTitle;\n");

    expect(await extensionViolations(root)).toEqual([{ file: "src/panel.ts", line: 2, rule: "innerHTML" }]);
  });
});
