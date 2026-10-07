import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InstanceLock } from "@desk/core";
import { assertPathAllowed } from "./test-guard.ts";

function errorCode(err: unknown): string | undefined {
  return err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === "EPERM";
  }
}

/**
 * `run/<name>.lock` (docs/IMPLEMENTATION.md §3, §4.1): a 0600 file naming the holder's pid (and what it adds, such as
 * its build), created whole with link(2), so nobody ever reads a half-written lock. A lock whose holder is dead is
 * reclaimed. This process signals nothing; it only asks whether the pid exists.
 */
export class NodeInstanceLock implements InstanceLock {
  private readonly runDir: string;
  private readonly extra: Readonly<Record<string, unknown>>;

  constructor(runDir: string, extra: Readonly<Record<string, unknown>> = {}) {
    this.runDir = runDir;
    this.extra = extra;
  }

  async acquire(name: string): Promise<{ ok: true; release(): Promise<void> } | { ok: false; heldBy: number }> {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`a lock name is a plain word, not ${JSON.stringify(name)}`);
    const path = join(this.runDir, `${name}.lock`);
    await assertPathAllowed(path);
    await mkdir(this.runDir, { recursive: true, mode: 0o700 });
    const text = `${JSON.stringify({ pid: process.pid, ...this.extra })}\n`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(tmp, text, { mode: 0o600, flag: "wx" });
      try {
        await link(tmp, path);
        return { ok: true, release: () => this.release(path) };
      } catch (err) {
        if (errorCode(err) !== "EEXIST") throw err;
      } finally {
        await rm(tmp, { force: true });
      }
      const holder = await this.holder(path);
      if (holder !== null && (holder === process.pid || processAlive(holder))) return { ok: false, heldBy: holder };
      await rm(path, { force: true });
    }
    const holder = await this.holder(path);
    return { ok: false, heldBy: holder ?? 0 };
  }

  private async holder(path: string): Promise<number | null> {
    try {
      const json: unknown = JSON.parse(await readFile(path, "utf8"));
      const pid = typeof json === "object" && json !== null && "pid" in json ? json.pid : null;
      return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  private async release(path: string): Promise<void> {
    if ((await this.holder(path)) === process.pid) await unlink(path).catch(() => undefined);
  }
}
