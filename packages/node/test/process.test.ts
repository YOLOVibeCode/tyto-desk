import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CryptoRandom, NodeDetachedSpawner, NodeLoginShell, NodeProcessInfo, NodeProcessSignals, SystemClock } from "../src/index.ts";
import { fakeExecutable } from "../../../test/fixtures/fake-exec.ts";

/** The file's text once it exists, polled every 20 ms for at most `budgetMs`. */
async function waitForFile(path: string, budgetMs: number): Promise<string> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`${path} did not appear within ${budgetMs} ms`, { cause: err });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

describe("process adapters", () => {
  it("the detached spawner starts a process with exactly the environment it is given and returns its pid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "detached-"));
    const out = join(dir, "out.json");
    const script = join(dir, "child.mjs");
    await writeFile(script, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(out)}, JSON.stringify({ pid: process.pid, env: process.env }));\n`);

    const pid = await new NodeDetachedSpawner().spawn(process.execPath, [script], { HOME: dir, DESK_HOME: join(dir, ".desk") });
    const child = JSON.parse(await waitForFile(out, 10_000)) as { pid: number; env: Record<string, string> };

    expect(child.pid).toBe(pid);
    expect(child.env.HOME).toBe(dir);
    expect(child.env.DESK_HOME).toBe(join(dir, ".desk"));
    expect(child.env.PATH).toBeUndefined();
    expect(child.env.VITEST).toBeUndefined();
  });

  it("the detached spawner returns null for a program that does not exist", async () => {
    expect(await new NodeDetachedSpawner().spawn("/nonexistent/desk-ptyd", [], {})).toBeNull();
  });

  it("process info reports this process alive and a finished one dead", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(child, "exit");

    expect(await new NodeProcessInfo().alive(process.pid)).toBe(true);
    expect(await new NodeProcessInfo().alive(child.pid ?? 0)).toBe(false);
  });

  it("process info reads when a process started from ps's elapsed time, through argv and a plain environment", async () => {
    const ps = await fakeExecutable("ps", [{ match: ["-o", "etime=", "-p", "4242"], stdout: "  1-02:03:04\n" }]);
    const before = Date.now();

    const started = await new NodeProcessInfo({ ps: ps.path }).startedAt(4242);

    const elapsedMs = ((26 * 60 + 3) * 60 + 4) * 1000;
    expect(started).toBeGreaterThanOrEqual(before - elapsedMs - 1_000);
    expect(started).toBeLessThanOrEqual(Date.now() - elapsedMs);
    expect((await ps.calls()).map((call) => call.argv)).toEqual([["-o", "etime=", "-p", "4242"]]);
    expect((await ps.calls()).map((call) => call.env.PATH)).toEqual(["/usr/bin:/bin"]);
    expect((await ps.calls()).map((call) => call.env.LC_ALL)).toEqual(["C"]);
  });

  it.each([
    ["ps lists no such process", { exit: 1 }],
    ["ps prints no elapsed time", { stdout: "\n" }],
    ["ps prints something else", { stdout: "ELAPSED\n" }],
  ])("process info has no start time when %s", async (_label, answer) => {
    const ps = await fakeExecutable("ps", [{ match: ["-o", "etime="], ...answer }]);

    expect(await new NodeProcessInfo({ ps: ps.path }).startedAt(4242)).toBeNull();
  });

  it("process info's start time for this process is when it started, within a second or two", async () => {
    const started = await new NodeProcessInfo().startedAt(process.pid);

    expect(started).not.toBeNull();
    expect(Math.abs((started ?? 0) - (Date.now() - process.uptime() * 1000))).toBeLessThan(2_000);
  });

  it("process signals end a process with SIGTERM", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(child, "spawn");
    const exited = once(child, "exit");

    expect(await new NodeProcessSignals().terminate(child.pid ?? -1)).toBe(true);
    expect((await exited)[1]).toBe("SIGTERM");
  });

  it.each([
    ["pid 1", () => 1],
    ["its own pid", () => process.pid],
    ["a pid that is not a positive integer", () => 0],
  ])("process signals refuse %s and send nothing", async (_, pid) => {
    expect(await new NodeProcessSignals().terminate(pid())).toBe(false);
  });

  it("process signals report a process that is already gone", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(child, "exit");

    expect(await new NodeProcessSignals().terminate(child.pid ?? -1)).toBe(false);
  });

  it("the login shell is the account's passwd shell", async () => {
    const shell = userInfo().shell;

    expect(await new NodeLoginShell().passwdShell()).toBe(shell === "" ? null : shell);
  });

  it("random ids are a prefix and 10 lowercase Crockford base32 characters, and ints stay in range", () => {
    const random = new CryptoRandom();
    const ids = new Set(Array.from({ length: 100 }, () => random.id("p")));

    for (const id of ids) expect(id).toMatch(/^p_[0-9abcdefghjkmnpqrstvwxyz]{10}$/);
    expect(ids.size).toBe(100);
    for (let i = 0; i < 100; i += 1) {
      const value = random.int(3, 5);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(5);
    }
  });

  it("the system clock sleeps for at least the time asked", async () => {
    const clock = new SystemClock();
    const start = clock.now();

    await clock.sleep(20);

    expect(clock.now() - start).toBeGreaterThanOrEqual(19);
  });
});
