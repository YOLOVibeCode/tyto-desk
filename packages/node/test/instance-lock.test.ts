import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeInstanceLock } from "../src/index.ts";

/** A pid that no process has: one that ran and exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  if (child.pid === undefined) throw new Error("no pid");
  return child.pid;
}

describe("NodeInstanceLock", () => {
  it("a lock is a 0600 file in a 0700 run directory naming its holder's pid, removed on release", async () => {
    const run = join(await mkdtemp(join(tmpdir(), "lock-")), "run");
    const lock = new NodeInstanceLock(run);

    const held = await lock.acquire("launch");
    if (!held.ok) throw new Error("expected the lock");
    const text = await readFile(join(run, "launch.lock"), "utf8");
    const modes = { file: (await stat(join(run, "launch.lock"))).mode & 0o777, dir: (await stat(run)).mode & 0o777 };
    await held.release();

    expect(JSON.parse(text)).toEqual({ pid: process.pid });
    expect(modes).toEqual({ file: 0o600, dir: 0o700 });
    await expect(stat(join(run, "launch.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a lock held by a live process refuses and names the holder", async () => {
    const run = join(await mkdtemp(join(tmpdir(), "lock-")), "run");
    await mkdir(run, { mode: 0o700 });
    await writeFile(join(run, "install.lock"), JSON.stringify({ pid: process.ppid }), { mode: 0o600 });

    expect(await new NodeInstanceLock(run).acquire("install")).toEqual({ ok: false, heldBy: process.ppid });
  });

  it("a dead holder's lock is reclaimed", async () => {
    const run = join(await mkdtemp(join(tmpdir(), "lock-")), "run");
    await mkdir(run, { mode: 0o700 });
    await writeFile(join(run, "ptyd.lock"), JSON.stringify({ pid: await deadPid() }), { mode: 0o600 });

    const held = await new NodeInstanceLock(run).acquire("ptyd");

    expect(held.ok).toBe(true);
    expect(JSON.parse(await readFile(join(run, "ptyd.lock"), "utf8"))).toEqual({ pid: process.pid });
  });

  it("a second acquire in the same process refuses while the first holds the lock", async () => {
    const run = join(await mkdtemp(join(tmpdir(), "lock-")), "run");
    const lock = new NodeInstanceLock(run);
    const first = await lock.acquire("launch");

    expect(await lock.acquire("launch")).toEqual({ ok: false, heldBy: process.pid });
    if (first.ok) await first.release();
    expect((await lock.acquire("launch")).ok).toBe(true);
  });

  it("a lock records what its holder adds, such as its build", async () => {
    const run = join(await mkdtemp(join(tmpdir(), "lock-")), "run");

    await new NodeInstanceLock(run, { build: "0.3.0" }).acquire("ptyd");

    expect(JSON.parse(await readFile(join(run, "ptyd.lock"), "utf8"))).toEqual({ pid: process.pid, build: "0.3.0" });
  });

  it("the lock refuses a lock name that is not a plain word", async () => {
    const lock = new NodeInstanceLock(join(await mkdtemp(join(tmpdir(), "lock-")), "run"));

    await expect(lock.acquire("../escape")).rejects.toThrow(/lock name/);
  });
});
