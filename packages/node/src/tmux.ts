import { access, constants } from "node:fs/promises";
import type { Tmux } from "@desk/core";
import { runArgv } from "./run.ts";

/** Where Desk looks for tmux when the config names none. */
const TMUX_CANDIDATES = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"];

/**
 * The tmux binary the config names, else the first installed candidate; `null` when tmux is not installed. Under Vitest
 * it never finds the operator's own tmux (§0): only a binary a test names.
 */
export async function findTmux(configured: string | null, env: Readonly<Record<string, string | undefined>> = process.env): Promise<string | null> {
  if (configured === null && env.VITEST !== undefined) return null;
  for (const candidate of configured === null ? TMUX_CANDIDATES : [configured]) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return null;
}

/** The variables a tmux client needs to find the user's server; never `TMUX`, which would point at a session's. */
const PASSED = ["HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMUX_TMPDIR"];

/**
 * The user's tmux on its default socket (docs/IMPLEMENTATION.md §3), through `tmux` argv with a 3 s timeout. It reads and
 * appends to the server's global `update-environment` only; it never runs `show-environment`.
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

  async appendUpdateEnvironment(names: readonly string[]): Promise<boolean> {
    if (names.length === 0 || names.some((name) => !/^[A-Z_][A-Z0-9_]*$/.test(name))) return false;
    const result = await runArgv(this.binary, ["set-option", "-ga", "update-environment", ` ${names.join(" ")}`], { env: this.env, timeoutMs: 3_000 });
    return result.code === 0;
  }
}
