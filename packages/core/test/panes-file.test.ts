import { describe, expect, it } from "vitest";
import { parseStoredPanes, type PanesFile } from "../src/index.ts";

const P1 = "p_k2m9q3x7ab";
const file: PanesFile = {
  version: 1,
  panes: { [P1]: { cwd: "/Users/alex/Dev/tyto-desk", tmux: "work", lastTmux: "work", shell: "/bin/zsh" } },
};

describe("panes.json (docs/IMPLEMENTATION.md §7.4)", () => {
  it("panes.json reads back what was saved", () => {
    expect(parseStoredPanes(JSON.stringify(file))).toEqual({ panes: file, recovered: false });
  });

  it.each([
    ["a title", { ...file.panes[P1], title: "vim secrets.txt" }],
    ["output", { ...file.panes[P1], output: "password: hunter2" }],
    ["input", { ...file.panes[P1], input: "export TOKEN=x" }],
    ["a relative cwd", { ...file.panes[P1], cwd: "Dev/tyto-desk" }],
    ["a tmux name with a control character", { ...file.panes[P1], tmux: "work\u001b[31m" }],
    ["a relative shell", { ...file.panes[P1], shell: "zsh" }],
  ])("a panes.json whose record holds %s is moved aside and nothing is loaded", (_, record) => {
    expect(parseStoredPanes(JSON.stringify({ version: 1, panes: { [P1]: record } }))).toEqual({ panes: null, recovered: true });
  });

  it.each([
    ["text that is not JSON", "{"],
    ["a newer version", JSON.stringify({ ...file, version: 2 })],
    ["a key this build does not know", JSON.stringify({ ...file, layout: {} })],
    ["a pane id that is not one", JSON.stringify({ version: 1, panes: { nope: file.panes[P1] } })],
  ])("%s in panes.json is moved aside", (_, text) => {
    expect(parseStoredPanes(text).recovered).toBe(true);
  });
});
