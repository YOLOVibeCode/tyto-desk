import { readlink } from "node:fs/promises";
import type { ProcessCwd } from "@desk/core";
import { runArgv } from "./run.ts";

/**
 * A process's working directory (docs/IMPLEMENTATION.md §10): `/proc/<pid>/cwd` on Linux; on macOS
 * `lsof -a -p <pid> -d cwd -Fn`, whose `n` line is the path. Argv, the C locale, 2 s.
 */
export class NodeProcessCwd implements ProcessCwd {
  private readonly lsof: string;
  private readonly procRoot: string | null;

  constructor(options: { lsof?: string; procRoot?: string | null } = {}) {
    this.lsof = options.lsof ?? (process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof");
    this.procRoot = options.procRoot === undefined ? (process.platform === "linux" ? "/proc" : null) : options.procRoot;
  }

  async cwdOf(pid: number): Promise<string | null> {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (this.procRoot !== null) return readlink(`${this.procRoot}/${pid}/cwd`).catch(() => null);
    const result = await runArgv(this.lsof, ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
      timeoutMs: 2_000,
      maxBytes: 65_536,
    });
    if (result.code !== 0) return null;
    const path = result.stdout.split("\n").find((line) => line.startsWith("n/"));
    return path === undefined ? null : path.slice(1);
  }
}
