import { spawn } from "node:child_process";
import { randomInt, randomBytes } from "node:crypto";
import { readlink } from "node:fs/promises";
import { userInfo } from "node:os";
import type { Clock, DetachedSpawner, ListenerInfo, LoginShell, ProcessInfo, ProcessSignals, Random } from "@desk/core";
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

/**
 * SIGTERM to another Desk process (`desk watch`, §6.3, §6.4). It refuses pid 1, its own pid, and anything but a positive
 * integer, and reports a process that is already gone. Desk never signals Chrome: it quits through `Browser.close`.
 */
export class NodeProcessSignals implements ProcessSignals {
  async terminate(pid: number): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false;
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch (err) {
      if (err instanceof Error && "code" in err && (err.code === "ESRCH" || err.code === "EPERM")) return false;
      throw err;
    }
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

  /** `ps -axww -o pid=,args=` (every process, full argument lines); only the matching pids leave this method. */
  async withArgument(argument: string): Promise<number[] | null> {
    const result = await runArgv(this.ps, ["-axww", "-o", "pid=,args="], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      timeoutMs: 3_000,
      maxBytes: 16 * 1024 * 1024,
    });
    if (result.code !== 0) return null;
    const pids: number[] = [];
    for (const line of result.stdout.split("\n")) {
      const match = /^\s*(\d+)\s(.*)$/.exec(line);
      if (match !== null && ` ${match[2] ?? ""} `.includes(` ${argument} `)) pids.push(Number(match[1]));
    }
    return pids;
  }
}

/**
 * Who listens on a 127.0.0.1 TCP port: `lsof -nP -iTCP@127.0.0.1:<port> -sTCP:LISTEN -Fp`; and a process's image: its
 * executable (`/proc/<pid>/exe` on Linux, where `ps` shortens the name; `ps -o comm=` on macOS, which prints the path)
 * and its argument line (`ps -ww -o args=`). Argv, the C locale, 3 s each.
 */
export class NodeListenerInfo implements ListenerInfo {
  private readonly lsof: string;
  private readonly ps: string;
  private readonly procRoot: string | null;

  constructor(options: { lsof?: string; ps?: string; procRoot?: string | null } = {}) {
    this.lsof = options.lsof ?? (process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof");
    this.ps = options.ps ?? "/bin/ps";
    this.procRoot = options.procRoot === undefined ? (process.platform === "linux" ? "/proc" : null) : options.procRoot;
  }

  async listenerPid(port: number): Promise<number | null> {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
    const result = await runArgv(this.lsof, ["-nP", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN", "-Fp"], {
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
      timeoutMs: 3_000,
      maxBytes: 65_536,
    });
    if (result.code !== 0) return null;
    const pids = new Set(result.stdout.split("\n").filter((line) => /^p\d+$/.test(line)).map((line) => Number(line.slice(1))));
    // One process listens, or Desk cannot tell which one Chrome is.
    return pids.size === 1 ? ([...pids][0] ?? null) : null;
  }

  async image(pid: number): Promise<{ exe: string; args: string } | null> {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const options = { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeoutMs: 3_000, maxBytes: 1024 * 1024 };
    let exe: string | null;
    if (this.procRoot !== null) {
      exe = await readlink(`${this.procRoot}/${pid}/exe`).catch(() => null);
    } else {
      const comm = await runArgv(this.ps, ["-o", "comm=", "-p", String(pid)], options);
      exe = comm.code === 0 && comm.stdout.trim().startsWith("/") ? comm.stdout.trim() : null;
    }
    if (exe === null) return null;
    const args = await runArgv(this.ps, ["-ww", "-o", "args=", "-p", String(pid)], options);
    if (args.code !== 0 || args.stdout.trim() === "") return null;
    return { exe, args: args.stdout.trim() };
  }
}

/** The account's passwd shell, which no environment variable changes. */
/** The variables a login shell starts with: who and where you are, never anything else of Desk's environment. */
const LOGIN_SHELL_ENV = ["HOME", "USER", "LOGNAME", "PATH", "LANG", "TERM"];

/**
 * The account's passwd shell, and what a login shell of it exports (§15.3): `[shell, "-l", "-i", "-c", "env | cut -d=
 * -f1"]`, a constant payload, so values never leave the child; `which` passes the command as `$1`, never in the payload.
 */
export class NodeLoginShell implements LoginShell {
  private readonly env: Record<string, string>;
  private readonly shellOverride: string | null;

  constructor(options: { env?: Readonly<Record<string, string | undefined>>; shell?: string } = {}) {
    this.env = {};
    for (const name of LOGIN_SHELL_ENV) {
      const value = (options.env ?? process.env)[name];
      if (value !== undefined) this.env[name] = value;
    }
    this.shellOverride = options.shell ?? null;
  }

  async passwdShell(): Promise<string | null> {
    if (this.shellOverride !== null) return this.shellOverride;
    const shell = userInfo().shell;
    return shell === null || shell === "" ? null : shell;
  }

  async exportedNames(): Promise<readonly string[] | null> {
    const shell = await this.passwdShell();
    if (shell === null) return null;
    const result = await runArgv(shell, ["-l", "-i", "-c", "env | cut -d= -f1"], { env: this.env, timeoutMs: 10_000, maxBytes: 1024 * 1024 });
    if (result.code !== 0) return null;
    return [...new Set(result.stdout.split("\n").filter((line) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(line)))].sort();
  }

  async which(command: string): Promise<string | null> {
    const shell = await this.passwdShell();
    if (shell === null || !/^[\w.-]+$/.test(command)) return null;
    const result = await runArgv(shell, ["-l", "-c", 'command -v -- "$1"', "desk-which", command], { env: this.env, timeoutMs: 10_000 });
    const found = result.stdout.trim().split("\n").at(-1) ?? "";
    return result.code === 0 && found.startsWith("/") ? found : null;
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
