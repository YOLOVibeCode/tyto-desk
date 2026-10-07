import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import type { MirrorScreen, TerminalMirror } from "@desk/core";

/**
 * Each pane's mirror (docs/IMPLEMENTATION.md §7.3): an @xterm/headless terminal at the pane's size with
 * `terminal.scrollback` lines, serialized by addon-serialize 0.14.0. It has no `onData` hook to the PTY, so a terminal
 * query the shell prints is answered only by the owner's xterm.
 */
export class NodeTerminalMirror implements TerminalMirror {
  create(cols: number, rows: number, scrollback: number): MirrorScreen {
    const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    const serialize = new SerializeAddon();
    term.loadAddon(serialize);
    return {
      write: (data) => new Promise((resolve) => term.write(data, resolve)),
      flush: () => new Promise((resolve) => term.write("", resolve)),
      resize: (columns, lines) => term.resize(columns, lines),
      snapshot: () => ({ data: serialize.serialize({ scrollback }), altScreen: term.buffer.active.type === "alternate" }),
      dispose: () => term.dispose(),
    };
  }
}
