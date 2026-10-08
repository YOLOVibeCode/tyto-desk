import { readlink } from "node:fs/promises";
import type { ShellProbe } from "@desk/core";
import { runArgv } from "./run.ts";

const PS_ENV = { PATH: "/usr/bin:/bin", LC_ALL: "C" };

/**
 * A pane shell's terminal and whether it has children (docs/IMPLEMENTATION.md §7.4): on Linux `/proc/<pid>/fd/0`; on
 * macOS `ps -o tty=`, which names the terminal without `/dev/`; children from `ps -axo pid=,ppid=` on both. Argv, 2 s.
 */
export class NodeShellProbe implements ShellProbe {
  private readonly ps: string;
  private readonly procRoot: string | null;

  constructor(options: { ps?: string; procRoot?: string | null } = {}) {
    this.ps = options.ps ?? "/bin/ps";
    this.procRoot = options.procRoot === undefined ? (process.platform === "linux" ? "/proc" : null) : options.procRoot;
  }

  async ttyOf(pid: number): Promise<string | null> {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (this.procRoot !== null) {
      const target = await readlink(`${this.procRoot}/${pid}/fd/0`).catch(() => null);
      return target !== null && target.startsWith("/dev/") ? target : null;
    }
    const result = await runArgv(this.ps, ["-o", "tty=", "-p", String(pid)], { env: PS_ENV, timeoutMs: 2_000 });
    const tty = result.code === 0 ? result.stdout.trim() : "";
    return /^tty[\w/]+$/.test(tty) ? `/dev/${tty}` : null;
  }

  async hasChildren(pid: number): Promise<boolean> {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    const result = await runArgv(this.ps, ["-axo", "pid=,ppid="], { env: PS_ENV, timeoutMs: 2_000, maxBytes: 4 * 1024 * 1024 });
    if (result.code !== 0) return false;
    return result.stdout.split("\n").some((line) => {
      const [child, parent] = line.trim().split(/\s+/);
      return parent === String(pid) && child !== undefined && child !== "";
    });
  }
}
