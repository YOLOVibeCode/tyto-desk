import type { Tmux } from "@desk/core";
import { runArgv } from "./run.ts";

/** The variables a tmux client needs to find the user's server; never `TMUX`, which would point at a session's. */
const PASSED = ["HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMUX_TMPDIR"];

/**
 * The user's tmux on its default socket (docs/IMPLEMENTATION.md §3), through `tmux` argv with a 3 s timeout. It reads
 * only the server's global options; it never runs `show-environment`.
 */
export class NodeTmux implements Tmux {
  private readonly binary: string;
  private readonly env: Record<string, string>;

  constructor(binary: string, env: Readonly<Record<string, string | undefined>>) {
    this.binary = binary;
    this.env = {};
    for (const name of PASSED) {
      const value = env[name];
      if (value !== undefined) this.env[name] = value;
    }
  }

  async serverRunning(): Promise<boolean> {
    return (await this.updateEnvironment()) !== null;
  }

  async updateEnvironment(): Promise<readonly string[] | null> {
    const result = await runArgv(this.binary, ["show-options", "-g", "update-environment"], { env: this.env, timeoutMs: 3_000 });
    if (result.code !== 0) return null;
    const names: string[] = [];
    for (const line of result.stdout.split("\n")) {
      const match = /^update-environment(?:\[\d+\])? (.+)$/.exec(line.trim());
      if (match?.[1] !== undefined) names.push(...match[1].split(/\s+/).filter((name) => name !== ""));
    }
    return names;
  }
}
