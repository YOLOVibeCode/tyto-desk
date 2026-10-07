import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import type { MirrorScreen, TerminalMirror } from "@desk/core";

/**
 * Each pane's mirror (docs/IMPLEMENTATION.md §7.3): an @xterm/headless terminal at the pane's size with
 * `terminal.scrollback` lines, serialized by addon-serialize 0.14.0. It has no `onData` hook to the PTY, so a terminal
 * query the shell prints is answered only by the owner's xterm. Its writes never reject.
 */
export class NodeTerminalMirror implements TerminalMirror {
  create(cols: number, rows: number, scrollback: number): MirrorScreen {
    const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    const serialize = new SerializeAddon();
    term.loadAddon(serialize);
    return {
      // xterm refuses a write once 50 MB wait to be parsed; the daemon pauses the PTY long before that (D106), and a
      // refused write leaves the mirror short rather than ending the daemon.
      write: (data) =>
        new Promise((resolve) => {
          try {
            term.write(data, resolve);
          } catch {
            resolve();
          }
        }),
      flush: () => new Promise((resolve) => term.write("", resolve)),
      resize: (columns, lines) => term.resize(columns, lines),
      snapshot: () => ({ data: serialize.serialize({ scrollback }), altScreen: term.buffer.active.type === "alternate" }),
      dispose: () => term.dispose(),
    };
  }
}
