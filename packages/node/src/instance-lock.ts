import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InstanceLock, ProcessInfo } from "@desk/core";
import { NodeProcessInfo } from "./process.ts";
import { assertPathAllowed } from "./test-guard.ts";

function errorCode(err: unknown): string | undefined {
  return err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

/** How far a holder's recorded start may be from the one the system reports for its pid: `ps` counts whole seconds. */
const START_TOLERANCE_MS = 3_000;

/** A lock file as read: its text, and the pid and start it names (`null` when it names none). */
type Holder = { text: string; pid: number | null; startedAt: number | null; build: string | null };

export type InstanceLockOptions = {
  /** Whether the pid a lock names runs, and since when. */
  processes?: ProcessInfo;
  /** This holder's pid and start (ms since the epoch); by default this process's. */
  pid?: number;
  startedAt?: number;
};

/** The file's text, or `null` when it does not exist. */
async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return null;
    throw err;
  }
}

async function readHolder(path: string): Promise<Holder | null> {
  const text = await readText(path);
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { text, pid: null, startedAt: null, build: null };
  }
  const fields = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  const pid = typeof fields.pid === "number" && Number.isInteger(fields.pid) && fields.pid > 0 ? fields.pid : null;
  const started = typeof fields.startedAt === "string" ? Date.parse(fields.startedAt) : Number.NaN;
  return { text, pid, startedAt: Number.isNaN(started) ? null : started, build: typeof fields.build === "string" ? fields.build : null };
}

/** Creates `path` holding `text`, whole, with link(2): false when it exists. Nobody ever reads a half-written lock. */
async function linkWhole(path: string, text: string): Promise<boolean> {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, text, { mode: 0o600, flag: "wx" });
  try {
    await link(tmp, path);
    return true;
  } catch (err) {
    if (errorCode(err) !== "EEXIST") throw err;
    return false;
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Removes `path` when it still holds `text`. */
async function removeIfUnchanged(path: string, text: string): Promise<void> {
  if ((await readText(path)) !== text) return;
  await unlink(path).catch((err: unknown) => {
    if (errorCode(err) !== "ENOENT") throw err;
  });
}

/**
 * `run/<name>.lock` (docs/IMPLEMENTATION.md §3, §4.1, §7.1): a 0600 file naming the holder's pid, when it started, and
 * what it adds (such as its build), created whole with link(2). A holder is alive while its pid runs and that process
 * started when the lock says (D97): a pid the system has given to a newer process, after a reboot or a wrap, keeps no
 * lock. A dead holder's lock is reclaimed under `<name>.lock.reclaim`, also created with link(2), and only while it still
 * holds that holder's text, so of the processes that found the same dead holder only one takes the lock. This process
 * signals nothing; it only asks whether the pid exists and since when.
 */
export class NodeInstanceLock implements InstanceLock {
  private readonly runDir: string;
  private readonly extra: Readonly<Record<string, unknown>>;
  private readonly processes: ProcessInfo;
  private readonly pid: number;
  private readonly startedAt: number;

  constructor(runDir: string, extra: Readonly<Record<string, unknown>> = {}, options: InstanceLockOptions = {}) {
    this.runDir = runDir;
    this.extra = extra;
    this.processes = options.processes ?? new NodeProcessInfo();
    this.pid = options.pid ?? process.pid;
    this.startedAt = Math.round(options.startedAt ?? Date.now() - process.uptime() * 1_000);
  }

  async acquire(name: string): Promise<{ ok: true; release(): Promise<void> } | { ok: false; heldBy: number }> {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`a lock name is a plain word, not ${JSON.stringify(name)}`);
    const path = join(this.runDir, `${name}.lock`);
    await assertPathAllowed(path);
    await mkdir(this.runDir, { recursive: true, mode: 0o700 });
    const text = `${JSON.stringify({ pid: this.pid, ...this.extra, startedAt: new Date(this.startedAt).toISOString() })}\n`;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await linkWhole(path, text)) return { ok: true, release: () => removeIfUnchanged(path, text) };
      const holder = await readHolder(path);
      if (holder === null) continue;
      if (await this.alive(holder)) return { ok: false, heldBy: holder.pid ?? 0 };
      const reclaiming = await this.reclaim(path, holder.text, text);
      if (reclaiming !== null) return { ok: false, heldBy: reclaiming };
    }
    return { ok: false, heldBy: (await readHolder(path))?.pid ?? 0 };
  }

  async holder(name: string): Promise<{ pid: number; build: string | null } | null> {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`a lock name is a plain word, not ${JSON.stringify(name)}`);
    const path = join(this.runDir, `${name}.lock`);
    await assertPathAllowed(path);
    const holder = await readHolder(path);
    if (holder === null || holder.pid === null || !(await this.alive(holder))) return null;
    return { pid: holder.pid, build: holder.build };
  }

  /** Whether the lock's holder runs: its pid is alive and started when the lock says, give or take `ps`'s second. */
  private async alive(holder: Holder): Promise<boolean> {
    if (holder.pid === null) return false;
    if (holder.pid === this.pid) return holder.startedAt !== null && Math.abs(holder.startedAt - this.startedAt) <= START_TOLERANCE_MS;
    if (!(await this.processes.alive(holder.pid))) return false;
    if (holder.startedAt === null) return true;
    const started = await this.processes.startedAt(holder.pid);
    return started === null || Math.abs(started - holder.startedAt) <= START_TOLERANCE_MS;
  }

  /**
   * Removes a dead holder's lock while holding `<lock>.reclaim`. Nothing replaces an existing lock file (link(2) fails
   * on it) and every reclaimer holds the gate, so a lock that still holds the dead holder's text is that lock. Returns
   * the pid of a live process reclaiming it now (it takes the lock next), else null; a gate whose holder died inside it
   * is cleared.
   */
  private async reclaim(path: string, staleText: string, text: string): Promise<number | null> {
    const gate = `${path}.reclaim`;
    if (!(await linkWhole(gate, text))) {
      const reclaimer = await readHolder(gate);
      if (reclaimer === null) return null;
      if (await this.alive(reclaimer)) return reclaimer.pid ?? 0;
      await removeIfUnchanged(gate, reclaimer.text);
      return null;
    }
    try {
      await removeIfUnchanged(path, staleText);
    } finally {
      await removeIfUnchanged(gate, text);
    }
    return null;
  }
}
