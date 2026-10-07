import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeProcessInfo } from "@desk/core/testing";
import { NodeInstanceLock } from "../src/index.ts";

/** A pid that no process has: one that ran and exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  if (child.pid === undefined) throw new Error("no pid");
  return child.pid;
}

async function runDir(): Promise<string> {
  const run = join(await mkdtemp(join(tmpdir(), "lock-")), "run");
  await mkdir(run, { mode: 0o700 });
  return run;
}

const T0 = Date.parse("2026-10-07T08:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** FakeProcessInfo whose first `alive` question about `pid` waits until the test opens it. */
class HeldProcessInfo extends FakeProcessInfo {
  private readonly pid: number;
  private asked = false;
  private open: () => void = () => undefined;
  private readonly opened = new Promise<void>((resolve) => {
    this.open = resolve;
  });
  readonly waiting: Promise<void>;
  private reached: () => void = () => undefined;

  constructor(live: number[], pid: number) {
    super(live);
    this.pid = pid;
    this.waiting = new Promise((resolve) => {
      this.reached = resolve;
    });
  }

  override async alive(pid: number): Promise<boolean> {
    if (pid === this.pid && !this.asked) {
      this.asked = true;
      this.reached();
      await this.opened;
    }
    return super.alive(pid);
  }

  release(): void {
    this.open();
  }
}

describe("NodeInstanceLock", () => {
  it("a lock is a 0600 file in a 0700 run directory naming its holder's pid and start, removed on release", async () => {
    const run = join(await mkdtemp(join(tmpdir(), "lock-")), "run");
    const lock = new NodeInstanceLock(run, {}, { startedAt: T0 });

    const held = await lock.acquire("launch");
    if (!held.ok) throw new Error("expected the lock");
    const text = await readFile(join(run, "launch.lock"), "utf8");
    const modes = { file: (await stat(join(run, "launch.lock"))).mode & 0o777, dir: (await stat(run)).mode & 0o777 };
    await held.release();

    expect(JSON.parse(text)).toEqual({ pid: process.pid, startedAt: iso(T0) });
    expect(modes).toEqual({ file: 0o600, dir: 0o700 });
    await expect(stat(join(run, "launch.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a lock records when its holder started", async () => {
    const run = await runDir();

    await new NodeInstanceLock(run).acquire("launch");

    const { startedAt } = JSON.parse(await readFile(join(run, "launch.lock"), "utf8")) as { startedAt: string };
    expect(Math.abs(Date.parse(startedAt) - (Date.now() - process.uptime() * 1000))).toBeLessThan(1_000);
  });

  it("a lock held by a live process refuses and names the holder", async () => {
    const run = await runDir();
    await writeFile(join(run, "install.lock"), JSON.stringify({ pid: process.ppid }), { mode: 0o600 });

    expect(await new NodeInstanceLock(run).acquire("install")).toEqual({ ok: false, heldBy: process.ppid });
  });

  it("a lock whose holder runs since the start the lock records refuses", async () => {
    const run = await runDir();
    await writeFile(join(run, "ptyd.lock"), JSON.stringify({ pid: 4242, startedAt: iso(T0) }), { mode: 0o600 });
    const processes = new FakeProcessInfo([4242]);
    processes.started.set(4242, T0 + 800);

    expect(await new NodeInstanceLock(run, {}, { processes }).acquire("ptyd")).toEqual({ ok: false, heldBy: 4242 });
  });

  it("a dead holder's lock is reclaimed", async () => {
    const run = await runDir();
    await writeFile(join(run, "ptyd.lock"), JSON.stringify({ pid: await deadPid() }), { mode: 0o600 });

    const held = await new NodeInstanceLock(run, {}, { startedAt: T0 }).acquire("ptyd");

    expect(held.ok).toBe(true);
    expect(JSON.parse(await readFile(join(run, "ptyd.lock"), "utf8"))).toEqual({ pid: process.pid, startedAt: iso(T0) });
  });

  it("a lock naming a pid the system has given to a newer process is reclaimed", async () => {
    const run = await runDir();
    await writeFile(join(run, "ptyd.lock"), JSON.stringify({ pid: 4242, build: "0.3.0", startedAt: iso(T0) }), { mode: 0o600 });
    const processes = new FakeProcessInfo([4242]);
    processes.started.set(4242, T0 + 3_600_000);

    const held = await new NodeInstanceLock(run, {}, { processes, pid: 5151, startedAt: T0 + 7_200_000 }).acquire("ptyd");

    expect(held.ok).toBe(true);
    expect(JSON.parse(await readFile(join(run, "ptyd.lock"), "utf8"))).toMatchObject({ pid: 5151 });
  });

  it("a lock an earlier process with this process's pid left is reclaimed", async () => {
    const run = await runDir();
    await writeFile(join(run, "ptyd.lock"), JSON.stringify({ pid: process.pid, startedAt: iso(T0) }), { mode: 0o600 });

    const held = await new NodeInstanceLock(run, {}, { startedAt: T0 + 3_600_000 }).acquire("ptyd");

    expect(held.ok).toBe(true);
  });

  it("a second acquire in the same process refuses while the first holds the lock", async () => {
    const run = join(await mkdtemp(join(tmpdir(), "lock-")), "run");
    const lock = new NodeInstanceLock(run);
    const first = await lock.acquire("launch");

    expect(await lock.acquire("launch")).toEqual({ ok: false, heldBy: process.pid });
    if (first.ok) await first.release();
    expect((await lock.acquire("launch")).ok).toBe(true);
  });

  it("two processes that find the same dead holder never both take the lock", async () => {
    const run = await runDir();
    await writeFile(join(run, "ptyd.lock"), JSON.stringify({ pid: 4040, startedAt: iso(T0) }), { mode: 0o600 });
    const processes = new HeldProcessInfo([5151, 6161], 4040);
    processes.started.set(5151, T0 + 60_000);
    processes.started.set(6161, T0 + 60_000);
    const slow = new NodeInstanceLock(run, {}, { processes, pid: 6161, startedAt: T0 + 60_000 });
    const fast = new NodeInstanceLock(run, {}, { processes, pid: 5151, startedAt: T0 + 60_000 });

    // The slow process reads the dead holder's lock, then waits; the fast one reclaims it and takes the lock.
    const slowAttempt = slow.acquire("ptyd");
    await processes.waiting;
    const fastAttempt = await fast.acquire("ptyd");
    processes.release();
    const slowResult = await slowAttempt;

    expect(fastAttempt.ok).toBe(true);
    expect(slowResult).toEqual({ ok: false, heldBy: 5151 });
    expect(JSON.parse(await readFile(join(run, "ptyd.lock"), "utf8"))).toMatchObject({ pid: 5151 });
  });

  it("a reclaim that a process left half done, because it died inside it, does not keep the lock from being taken", async () => {
    const run = await runDir();
    const dead = await deadPid();
    await writeFile(join(run, "ptyd.lock"), JSON.stringify({ pid: dead, startedAt: iso(T0) }), { mode: 0o600 });
    await writeFile(join(run, "ptyd.lock.reclaim"), JSON.stringify({ pid: dead, startedAt: iso(T0) }), { mode: 0o600 });

    const held = await new NodeInstanceLock(run).acquire("ptyd");

    expect(held.ok).toBe(true);
    expect((await readdir(run)).sort()).toEqual(["ptyd.lock"]);
  });

  it("a lock records what its holder adds, such as its build", async () => {
    const run = join(await mkdtemp(join(tmpdir(), "lock-")), "run");

    await new NodeInstanceLock(run, { build: "0.3.0" }, { startedAt: T0 }).acquire("ptyd");

    expect(JSON.parse(await readFile(join(run, "ptyd.lock"), "utf8"))).toEqual({ pid: process.pid, build: "0.3.0", startedAt: iso(T0) });
  });

  it("the lock names a live holder's pid and the build it recorded", async () => {
    const run = await runDir();
    await writeFile(join(run, "watch.lock"), JSON.stringify({ pid: 4242, build: "0.3.0", startedAt: iso(T0) }), { mode: 0o600 });
    const processes = new FakeProcessInfo([4242]);
    processes.started.set(4242, T0 + 800);

    expect(await new NodeInstanceLock(run, {}, { processes }).holder("watch")).toEqual({ pid: 4242, build: "0.3.0" });
  });

  it.each([
    ["no lock", null],
    ["a dead holder", { pid: 4343, build: "0.3.0", startedAt: iso(T0) }],
    ["a pid the system has given to a newer process", { pid: 4242, build: "0.3.0", startedAt: iso(T0 - 3_600_000) }],
  ])("the lock names no holder for %s", async (_, record) => {
    const run = await runDir();
    if (record !== null) await writeFile(join(run, "watch.lock"), JSON.stringify(record), { mode: 0o600 });
    const processes = new FakeProcessInfo([4242]);
    processes.started.set(4242, T0);

    expect(await new NodeInstanceLock(run, {}, { processes }).holder("watch")).toBeNull();
  });

  it("the lock refuses a lock name that is not a plain word", async () => {
    const lock = new NodeInstanceLock(join(await mkdtemp(join(tmpdir(), "lock-")), "run"));

    await expect(lock.acquire("../escape")).rejects.toThrow(/lock name/);
  });
});
