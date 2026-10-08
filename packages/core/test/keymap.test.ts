import { describe, expect, it } from "vitest";
import { bindingProblem, buildKeymap, keyDecision, type KeyInput } from "../src/index.ts";

/** A keydown as the panel sees it: `code` names the physical key, as KeyboardEvent.code does. */
const key = (code: string, mods: Partial<Pick<KeyInput, "meta" | "ctrl" | "alt" | "shift" | "composing">> = {}): KeyInput => ({
  code,
  meta: false,
  ctrl: false,
  alt: false,
  shift: false,
  composing: false,
  ...mods,
});

const ESC = "\u001b";

describe("the panel's keys (docs/IMPLEMENTATION.md §10)", () => {
  it.each([
    ["Cmd+T"],
    ["Cmd+N"],
    ["Cmd+Shift+N"],
    ["Cmd+W"],
    ["Cmd+Shift+W"],
    ["Cmd+Shift+T"],
    ["Cmd+Q"],
    ["Ctrl+Tab"],
    ["Ctrl+Shift+Tab"],
    ["Ctrl+PageUp"],
    ["Ctrl+PageDown"],
    ["Cmd+Opt+Left"],
    ["Cmd+Opt+Right"],
    ["Cmd+Shift+["],
    ["Cmd+Shift+]"],
    ["Ctrl+R"],
    ["Opt+B"],
    ["Escape"],
    ["Cmd+Nonsense"],
    [""],
  ])("keymap validation refuses Chrome-reserved keys and plain Ctrl, Option or Escape bindings: %s", (binding) => {
    expect(bindingProblem(binding)).not.toBeNull();
  });

  it.each([["Cmd+D"], ["Cmd+Shift+D"], ["Cmd+Opt+T"], ["Cmd+Ctrl+Left"], ["Ctrl+Shift+R"], ["Cmd+="], ["cmd+shift+enter"]])("keymap validation accepts %s", (binding) => {
    expect(bindingProblem(binding)).toBeNull();
  });

  it.each([
    ["Option+Left", key("ArrowLeft", { alt: true }), `${ESC}b`],
    ["Option+Right", key("ArrowRight", { alt: true }), `${ESC}f`],
    ["Option+Backspace", key("Backspace", { alt: true }), `${ESC}\u007f`],
    ["Cmd+Left", key("ArrowLeft", { meta: true }), "\u0001"],
    ["Cmd+Right", key("ArrowRight", { meta: true }), "\u0005"],
    ["Cmd+Backspace", key("Backspace", { meta: true }), "\u0015"],
    ["Shift+Enter", key("Enter", { shift: true }), `${ESC}\r`],
  ])("%s sends its sequence", (_label, input, sequence) => {
    expect(keyDecision(input, buildKeymap({}).keymap)).toEqual({ send: sequence });
  });

  it.each([
    ["Cmd+D", key("KeyD", { meta: true }), "split-right"],
    ["Cmd+Shift+D", key("KeyD", { meta: true, shift: true }), "split-down"],
    ["Cmd+Opt+T", key("KeyT", { meta: true, alt: true }), "new-tab"],
    ["Cmd+Opt+W", key("KeyW", { meta: true, alt: true }), "close"],
    ["Cmd+[", key("BracketLeft", { meta: true }), "previous"],
    ["Cmd+]", key("BracketRight", { meta: true }), "next"],
    ["Cmd+Shift+Enter", key("Enter", { meta: true, shift: true }), "zoom"],
    ["Cmd+Ctrl+Left", key("ArrowLeft", { meta: true, ctrl: true }), "resize-left"],
    ["Cmd+3", key("Digit3", { meta: true }), "tab-3"],
    ["Cmd+F", key("KeyF", { meta: true }), "find"],
    ["Cmd+G", key("KeyG", { meta: true }), "find-next"],
    ["Cmd+Shift+G", key("KeyG", { meta: true, shift: true }), "find-previous"],
    ["Cmd+K", key("KeyK", { meta: true }), "clear"],
    ["Cmd+=", key("Equal", { meta: true }), "font-larger"],
    ["Cmd+-", key("Minus", { meta: true }), "font-smaller"],
    ["Cmd+0", key("Digit0", { meta: true }), "font-reset"],
  ])("%s runs %s by default", (_label, input, action) => {
    expect(keyDecision(input, buildKeymap({}).keymap)).toEqual({ action });
  });

  it("keys the panel does not bind go to the terminal: Cmd+C, Cmd+V, Cmd+L, Ctrl+C and plain letters", () => {
    const { keymap } = buildKeymap({});

    for (const input of [key("KeyC", { meta: true }), key("KeyV", { meta: true }), key("KeyL", { meta: true }), key("KeyC", { ctrl: true }), key("KeyA")]) {
      expect(keyDecision(input, keymap)).toBeNull();
    }
  });

  it("key bindings are skipped while the user is composing text", () => {
    const { keymap } = buildKeymap({});

    expect(keyDecision(key("KeyD", { meta: true, composing: true }), keymap)).toBeNull();
    expect(keyDecision(key("ArrowLeft", { alt: true, composing: true }), keymap)).toBeNull();
  });

  it("a configured binding replaces the action's default, and a refused one keeps the default and is named", () => {
    const { keymap, refused } = buildKeymap({ "split-right": "Cmd+Shift+E", "new-tab": "Cmd+T", "no-such-action": "Cmd+Shift+Y" });

    expect(keyDecision(key("KeyE", { meta: true, shift: true }), keymap)).toEqual({ action: "split-right" });
    expect(keyDecision(key("KeyD", { meta: true }), keymap)).toBeNull();
    expect(keyDecision(key("KeyT", { meta: true, alt: true }), keymap)).toEqual({ action: "new-tab" });
    expect(refused).toEqual(["new-tab: Cmd+T belongs to Chrome", "no-such-action: not an action"]);
  });
});
