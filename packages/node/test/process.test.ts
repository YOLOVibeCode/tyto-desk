import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CryptoRandom, NodeDetachedSpawner, NodeListenerInfo, NodeLoginShell, NodeProcessInfo, NodeProcessSignals, SystemClock } from "../src/index.ts";
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

  it("Desk processes start with stdio ignored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stdio-"));
    const out = join(dir, "out.json");
    const script = join(dir, "child.mjs");
    await writeFile(
      script,
      `import { fstatSync, openSync, writeFileSync } from "node:fs"; const nul = fstatSync(openSync("/dev/null", "r")); writeFileSync(${JSON.stringify(out)}, JSON.stringify([0, 1, 2].map((fd) => { const s = fstatSync(fd); return s.dev === nul.dev && s.ino === nul.ino; })));\n`,
    );

    await new NodeDetachedSpawner().spawn(process.execPath, [script], { HOME: dir });

    expect(JSON.parse(await waitForFile(out, 10_000))).toEqual([true, true, true]);
  });

  it("ProcessInfo never runs ps with e or eww and never reads a process environment", async () => {
    const ps = await fakeExecutable("ps", [{ match: ["-o", "etime="], stdout: "  01:02\n" }]);

    await new NodeProcessInfo({ ps: ps.path }).startedAt(4242);
    await new NodeProcessInfo({ ps: ps.path }).alive(process.pid);
    const source = await readFile(new URL("../src/process.ts", import.meta.url), "utf8");

    for (const call of await ps.calls()) expect(call.argv.filter((arg) => /^-?[a-zA-Z]*e[a-zA-Z]*$/.test(arg) || arg.includes("ww"))).toEqual([]);
    expect(source).not.toMatch(/\/environ\b|["'`]environ["'`]/);
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

describe("which processes use the Desk profile, and who listens on its port (§6.1 step 4)", () => {
  const DIR = "/Users/alex/Library/Application Support/Desk/Chrome";

  it("process info lists the pids whose argument line holds the argument as a whole argument", async () => {
    const ps = await fakeExecutable("ps", [
      {
        match: ["-axww", "-o", "pid=,args="],
        stdout: [
          `  5100 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${DIR} --no-first-run`,
          `  5101 /Applications/Google Chrome.app/Contents/Frameworks/Helper --type=renderer --user-data-dir=${DIR}`,
          `  6000 /bin/zsh -c echo --user-data-dir=${DIR}2`,
          "  7000 /usr/sbin/cupsd -l",
          "",
        ].join("\n"),
      },
    ]);

    expect(await new NodeProcessInfo({ ps: ps.path }).withArgument(`--user-data-dir=${DIR}`)).toEqual([5100, 5101]);
    expect((await ps.calls()).map((call) => call.env.PATH)).toEqual(["/usr/bin:/bin"]);
  });

  it("process info cannot tell who uses the profile when ps fails", async () => {
    const ps = await fakeExecutable("ps", [{ match: ["-axww"], exit: 1 }]);

    expect(await new NodeProcessInfo({ ps: ps.path }).withArgument(`--user-data-dir=${DIR}`)).toBeNull();
  });

  it.each([
    ["one listener", "p5100\nf45\n", 5100],
    ["two listeners", "p5100\nf45\np6100\nf9\n", null],
    ["none", "", null],
  ])("listener info reads lsof's pid for %s", async (_, stdout, pid) => {
    const lsof = await fakeExecutable("lsof", [{ match: ["-nP", "-iTCP@127.0.0.1:9417", "-sTCP:LISTEN", "-Fp"], stdout }]);

    expect(await new NodeListenerInfo({ lsof: lsof.path, procRoot: null }).listenerPid(9417)).toBe(pid);
  });

  it("listener info reads a macOS image from ps's command path and argument line", async () => {
    const exe = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const ps = await fakeExecutable("ps", [
      { match: ["-o", "comm=", "-p", "5100"], stdout: `${exe}\n` },
      { match: ["-ww", "-o", "args=", "-p", "5100"], stdout: `${exe} --user-data-dir=${DIR}\n` },
    ]);

    expect(await new NodeListenerInfo({ ps: ps.path, procRoot: null }).image(5100)).toEqual({ exe, args: `${exe} --user-data-dir=${DIR}` });
  });

  it("listener info reads a Linux image's executable from /proc, where ps shortens the name", async () => {
    const proc = await mkdtemp(join(tmpdir(), "proc-"));
    await mkdir(join(proc, "5100"));
    await symlink("/opt/google/chrome/chrome", join(proc, "5100", "exe"));
    const ps = await fakeExecutable("ps", [{ match: ["-ww", "-o", "args=", "-p", "5100"], stdout: "/opt/google/chrome/chrome --user-data-dir=/home/alex/.config/Desk/Chrome\n" }]);

    expect(await new NodeListenerInfo({ ps: ps.path, procRoot: proc }).image(5100)).toEqual({
      exe: "/opt/google/chrome/chrome",
      args: "/opt/google/chrome/chrome --user-data-dir=/home/alex/.config/Desk/Chrome",
    });
  });

  it("listener info has no image for a process it cannot read", async () => {
    const proc = await mkdtemp(join(tmpdir(), "proc-"));

    expect(await new NodeListenerInfo({ procRoot: proc }).image(5100)).toBeNull();
  });
});
