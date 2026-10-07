import { spawn } from "node:child_process";
import { randomInt, randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import type { Clock, DetachedSpawner, LoginShell, ProcessInfo, Random } from "@desk/core";
import { runArgv } from "./run.ts";

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** Starts a process in its own session, stdio ignored, with exactly the environment given, and lets it go. */
export class NodeDetachedSpawner implements DetachedSpawner {
  spawn(file: string, args: readonly string[], env: Readonly<Record<string, string>>): Promise<number | null> {
    return new Promise((resolve) => {
      const child = spawn(file, [...args], { detached: true, stdio: "ignore", env: { ...env } });
      child.once("error", () => resolve(null));
      child.once("spawn", () => {
        child.unref();
        resolve(child.pid ?? null);
      });
    });
  }
}

/** `ps`'s elapsed time, `[[dd-]hh:]mm:ss`, in seconds; `null` for anything else. */
function elapsedSeconds(text: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text);
  if (match === null) return null;
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

/**
 * Facts about processes. `alive` signals nothing (signal 0 only checks). `startedAt` runs `ps -o etime= -p <pid>` (argv,
 * the C locale, 3 s; never an environment-reading flag), whose elapsed time is in whole seconds, the same on macOS and
 * procps.
 */
export class NodeProcessInfo implements ProcessInfo {
  private readonly ps: string;

  constructor(options: { ps?: string } = {}) {
    this.ps = options.ps ?? "/bin/ps";
  }

  async alive(pid: number): Promise<boolean> {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err instanceof Error && "code" in err && err.code === "EPERM";
    }
  }

  async startedAt(pid: number): Promise<number | null> {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const asked = Date.now();
    const result = await runArgv(this.ps, ["-o", "etime=", "-p", String(pid)], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      timeoutMs: 3_000,
      maxBytes: 4_096,
    });
    if (result.code !== 0) return null;
    const elapsed = elapsedSeconds(result.stdout.trim());
    return elapsed === null ? null : asked - elapsed * 1_000;
  }
}

/** The account's passwd shell, which no environment variable changes. */
export class NodeLoginShell implements LoginShell {
  async passwdShell(): Promise<string | null> {
    const shell = userInfo().shell;
    return shell === null || shell === "" ? null : shell;
  }
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** `crypto` randomness: uniform ints, and ids of 10 lowercase Crockford base32 characters. */
export class CryptoRandom implements Random {
  int(min: number, max: number): number {
    return randomInt(min, max + 1);
  }

  id(prefix: string): string {
    return `${prefix}_${[...randomBytes(10)].map((byte) => CROCKFORD[byte & 31] ?? "0").join("")}`;
  }
}
