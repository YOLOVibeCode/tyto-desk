import { spawn } from "node:child_process";
import { randomInt, randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import type { Clock, DetachedSpawner, LoginShell, ProcessInfo, Random } from "@desk/core";

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

/** Whether a pid exists; it signals nothing (signal 0 only checks). */
export class NodeProcessInfo implements ProcessInfo {
  async alive(pid: number): Promise<boolean> {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err instanceof Error && "code" in err && err.code === "EPERM";
    }
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
