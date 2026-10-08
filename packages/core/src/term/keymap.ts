import type { KeyInput } from "../ports/terminal-view.ts";

const TAB_ACTIONS = ["tab-1", "tab-2", "tab-3", "tab-4", "tab-5", "tab-6", "tab-7", "tab-8", "tab-9"] as const;

/** What a panel binding does (§10's table). */
export const PANEL_ACTIONS = [
  "new-tab",
  "close",
  "split-right",
  "split-down",
  "previous",
  "next",
  "zoom",
  "resize-left",
  "resize-right",
  "resize-up",
  "resize-down",
  ...TAB_ACTIONS,
  "find",
  "find-next",
  "find-previous",
  "clear",
  "font-larger",
  "font-smaller",
  "font-reset",
] as const;
export type PanelAction = (typeof PANEL_ACTIONS)[number];

/** §10's defaults on macOS; `terminal.keymap` replaces any of them. */
export const DEFAULT_BINDINGS: Readonly<Record<PanelAction, string>> = {
  "new-tab": "Cmd+Opt+T",
  close: "Cmd+Opt+W",
  "split-right": "Cmd+D",
  "split-down": "Cmd+Shift+D",
  previous: "Cmd+[",
  next: "Cmd+]",
  zoom: "Cmd+Shift+Enter",
  "resize-left": "Cmd+Ctrl+Left",
  "resize-right": "Cmd+Ctrl+Right",
  "resize-up": "Cmd+Ctrl+Up",
  "resize-down": "Cmd+Ctrl+Down",
  "tab-1": "Cmd+1",
  "tab-2": "Cmd+2",
  "tab-3": "Cmd+3",
  "tab-4": "Cmd+4",
  "tab-5": "Cmd+5",
  "tab-6": "Cmd+6",
  "tab-7": "Cmd+7",
  "tab-8": "Cmd+8",
  "tab-9": "Cmd+9",
  find: "Cmd+F",
  "find-next": "Cmd+G",
  "find-previous": "Cmd+Shift+G",
  clear: "Cmd+K",
  "font-larger": "Cmd+=",
  "font-smaller": "Cmd+-",
  "font-reset": "Cmd+0",
};

/**
 * What the shell gets for keys macOS users expect (§10's table): xterm 6 dropped Option+arrows; Cmd+arrows and
 * Cmd+Backspace edit the line as Ctrl+A, Ctrl+E and Ctrl+U do; Shift+Enter is Claude Code's newline.
 */
const SEQUENCES: ReadonlyMap<string, string> = new Map([
  ["Opt+Left", "\u001bb"],
  ["Opt+Right", "\u001bf"],
  ["Opt+Backspace", "\u001b\u007f"],
  ["Cmd+Left", "\u0001"],
  ["Cmd+Right", "\u0005"],
  ["Cmd+Backspace", "\u0015"],
  ["Shift+Enter", "\u001b\r"],
]);

/** Chrome's own shortcuts on macOS, from Chrome 155's source [RC]: a binding on one of them never reaches the panel. */
const CHROME_RESERVED = new Set([
  "Cmd+T",
  "Cmd+N",
  "Cmd+Shift+N",
  "Cmd+W",
  "Cmd+Shift+W",
  "Cmd+Shift+T",
  "Cmd+Q",
  "Ctrl+Tab",
  "Ctrl+Shift+Tab",
  "Ctrl+PageUp",
  "Ctrl+PageDown",
  "Cmd+Opt+Left",
  "Cmd+Opt+Right",
  "Cmd+Shift+[",
  "Cmd+Shift+]",
]);

/** `KeyboardEvent.code` → the key's name in a binding. */
const CODE_NAMES: Readonly<Record<string, string>> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Backspace: "Backspace",
  Delete: "Delete",
  Tab: "Tab",
  Escape: "Escape",
  Space: "Space",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  BracketLeft: "[",
  BracketRight: "]",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Comma: ",",
  Semicolon: ";",
  Quote: "'",
  Slash: "/",
  Backslash: "\\",
  Backquote: "`",
};

/** A key name as written in a binding (any case) → its canonical name. */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  left: "Left",
  right: "Right",
  up: "Up",
  down: "Down",
  enter: "Enter",
  return: "Enter",
  backspace: "Backspace",
  delete: "Delete",
  tab: "Tab",
  esc: "Escape",
  escape: "Escape",
  space: "Space",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

const MODIFIER_ALIASES: Readonly<Record<string, "Cmd" | "Ctrl" | "Opt" | "Shift">> = {
  cmd: "Cmd",
  command: "Cmd",
  meta: "Cmd",
  ctrl: "Ctrl",
  control: "Ctrl",
  opt: "Opt",
  option: "Opt",
  alt: "Opt",
  shift: "Shift",
};

type Mods = { Cmd: boolean; Ctrl: boolean; Opt: boolean; Shift: boolean };

function canonical(mods: Mods, key: string): string {
  return [...(["Cmd", "Ctrl", "Opt", "Shift"] as const).filter((mod) => mods[mod]), key].join("+");
}

function keyName(name: string): string | null {
  if (/^[a-z]$/i.test(name)) return name.toUpperCase();
  if (/^[0-9]$/.test(name)) return name;
  if (/^f([1-9]|1[0-2])$/i.test(name)) return name.toUpperCase();
  if (Object.values(CODE_NAMES).includes(name) && name.length === 1) return name;
  return KEY_ALIASES[name.toLowerCase()] ?? null;
}

/** A binding as written in the config (`Cmd+Shift+D`, any case) in its canonical form, or `null` when it is not one. */
function parseBinding(text: string): { mods: Mods; key: string; text: string } | null {
  // The last part is the key, so `Cmd+-` and `Cmd+=` read as written.
  const parts = text.trim().split("+");
  const last = parts.pop();
  if (last === undefined || last === "") return null;
  const mods: Mods = { Cmd: false, Ctrl: false, Opt: false, Shift: false };
  for (const part of parts) {
    const mod = MODIFIER_ALIASES[part.toLowerCase()];
    if (mod === undefined || mods[mod]) return null;
    mods[mod] = true;
  }
  const key = keyName(last);
  return key === null ? null : { mods, key, text: canonical(mods, key) };
}

/** The keydown as a canonical binding, or `null` for a key no binding names. */
function bindingOf(input: KeyInput): string | null {
  const key = /^Key[A-Z]$/.test(input.code)
    ? input.code.slice(3)
    : /^Digit[0-9]$/.test(input.code)
      ? input.code.slice(5)
      : /^F([1-9]|1[0-2])$/.test(input.code)
        ? input.code
        : (CODE_NAMES[input.code] ?? null);
  return key === null ? null : canonical({ Cmd: input.meta, Ctrl: input.ctrl, Opt: input.alt, Shift: input.shift }, key);
}

/**
 * Why a binding cannot be one (§10's keymap rules), or `null` when it can: it is not a key, Chrome takes it first, or it
 * belongs to the shell (Escape, plain Ctrl+letter, plain Option+letter, or a key without Cmd, Ctrl or Option).
 */
export function bindingProblem(text: string): string | null {
  const binding = parseBinding(text);
  if (binding === null) return "is not a key";
  if (CHROME_RESERVED.has(binding.text)) return "belongs to Chrome";
  const { mods, key } = binding;
  const letter = /^[A-Z]$/.test(key);
  if (key === "Escape" && !mods.Cmd) return "belongs to the shell";
  if (!mods.Cmd && !mods.Ctrl && !mods.Opt) return "belongs to the shell";
  if (letter && !mods.Cmd && !mods.Shift && mods.Ctrl !== mods.Opt) return "belongs to the shell";
  return null;
}

/**
 * The panel's keymap: §10's defaults, with `terminal.keymap`'s bindings in their place. A binding that cannot be one
 * keeps its action's default, and `refused` names it with the reason.
 */
export function buildKeymap(overrides: Readonly<Record<string, string>>): { keymap: ReadonlyMap<string, PanelAction>; refused: string[] } {
  const bindings: Record<string, string> = { ...DEFAULT_BINDINGS };
  const refused: string[] = [];
  for (const [action, binding] of Object.entries(overrides)) {
    if (!(PANEL_ACTIONS as readonly string[]).includes(action)) {
      refused.push(`${action}: not an action`);
      continue;
    }
    const problem = bindingProblem(binding);
    if (problem !== null) {
      refused.push(`${action}: ${binding} ${problem}`);
      continue;
    }
    bindings[action] = binding;
  }
  const keymap = new Map<string, PanelAction>();
  for (const action of PANEL_ACTIONS) {
    const parsed = parseBinding(bindings[action] ?? "");
    if (parsed !== null) keymap.set(parsed.text, action);
  }
  return { keymap, refused };
}

/**
 * What a keydown does in the panel: a bound action, a sequence for the shell, or `null` when the terminal should have
 * it as it is. Nothing is bound while the user is composing text with an input method (§10).
 */
export function keyDecision(input: KeyInput, keymap: ReadonlyMap<string, PanelAction>): { action: PanelAction } | { send: string } | null {
  if (input.composing) return null;
  const binding = bindingOf(input);
  if (binding === null) return null;
  const action = keymap.get(binding);
  if (action !== undefined) return { action };
  const sequence = SEQUENCES.get(binding);
  return sequence === undefined ? null : { send: sequence };
}
