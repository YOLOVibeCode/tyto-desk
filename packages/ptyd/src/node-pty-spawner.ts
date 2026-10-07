import { spawn } from "@lydell/node-pty";
import type { PtySpawnOptions, PtySpawner, Pty } from "@desk/core";

/**
 * Processes on real pseudo-terminals, through `@lydell/node-pty` (D71). The one file outside the live suites that
 * imports the PTY package; only the daemon's entry imports it, and the offline suite never reaches it
 * (scripts/lib/pty-boundary.mjs).
 */
export class NodePtySpawner implements PtySpawner {
  spawn(options: PtySpawnOptions): { ok: true; pty: Pty } | { ok: false } {
    let child;
    try {
      child = spawn(options.file, [...options.args], {
        name: "xterm-256color",
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: { ...options.env },
      });
    } catch {
      return { ok: false };
    }
    return {
      ok: true,
      pty: {
        pid: child.pid,
        write: (data) => child.write(data),
        resize: (cols, rows) => child.resize(cols, rows),
        kill: (signal) => child.kill(signal),
        pause: () => child.pause(),
        resume: () => child.resume(),
        onData: (listener) => {
          child.onData(listener);
        },
        onExit: (listener) => {
          child.onExit((exit) => listener({ code: exit.signal ? null : exit.exitCode, signal: exit.signal ?? null }));
        },
      },
    };
  }
}
