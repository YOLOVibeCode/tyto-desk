import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROTOCOL_MAX, PROTOCOL_MIN, newDeskConfig, type InstanceLock } from "@desk/core";
import { FakeInstanceLock, FakeProcessInfo, FakePtySpawner } from "@desk/core/testing";
import { NodeInstanceLock } from "@desk/node";
import { serveDaemon } from "../src/index.ts";

const UID = process.getuid?.() ?? null;
const VERSION = "0.3.1-dev.slice-1c+a1b2c3d";
const T0 = Date.parse("2026-10-07T08:00:00.000Z");

/** A fresh ~/.desk with its run directory, both 0700; short, since macOS caps a socket path at 104 bytes. */
async function freshDeskHome(): Promise<string> {
  const deskHome = join(await mkdtemp(join(tmpdir(), "d-")), ".desk");
  await mkdir(join(deskHome, "run"), { recursive: true, mode: 0o700 });
  await chmod(deskHome, 0o700);
  await chmod(join(deskHome, "run"), 0o700);
  return deskHome;
}

const exists = (path: string) => lstat(path).then(() => true, () => false);

/** Whether something accepts connections on the socket. */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ path });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the condition never held");
}

/** Starts the daemon's process logic with a fake PTY, signals the test sends, and the umask it would set. */
function serve(deskHome: string, options: { uid?: number | null; lock?: InstanceLock; order?: string[]; spawner?: FakePtySpawner } = {}) {
  const signals = new EventEmitter();
  const order = options.order ?? [];
  const exit = serveDaemon({
    deskHome,
    env: { HOME: dirname(deskHome) },
    version: VERSION,
    spawner: options.spawner ?? new FakePtySpawner(),
    uid: options.uid === undefined ? UID : options.uid,
    umask: (mask) => order.push(`umask ${mask.toString(8)}`),
    signals,
    ...(options.lock === undefined ? {} : { lock: options.lock }),
  });
  return { exit, signals, socket: join(deskHome, "run", "ptyd.sock"), lockFile: join(deskHome, "run", "ptyd.lock") };
}

describe("desk-ptyd, the process", () => {
  it("a restored pane whose saved directory is gone starts in HOME (§7.4)", async () => {
    const deskHome = await freshDeskHome();
    const home = dirname(deskHome);
    const pane = "p_k2m9q3x7ab";
    await writeFile(join(deskHome, "config.json"), JSON.stringify(newDeskConfig({ home, platform: "darwin", chromePort: 9417, gatewayPort: 9583 })), { mode: 0o600 });
    await writeFile(join(deskHome, "panes.json"), JSON.stringify({ version: 1, panes: { [pane]: { cwd: join(home, "gone"), tmux: null, lastTmux: null, shell: "/bin/sh" } } }), { mode: 0o600 });
    const spawner = new FakePtySpawner();
    const daemon = serve(deskHome, { spawner });
    await until(() => answers(daemon.socket));

    const socket = connect({ path: daemon.socket });
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write(`${JSON.stringify({ type: "hello", vMin: PROTOCOL_MIN, vMax: PROTOCOL_MAX, client: "panel", build: VERSION, window: 7 })}\n`);
    socket.write(`${JSON.stringify({ type: "open", id: "r1", pane, cols: 100, rows: 30 })}\n`);
    await until(async () => spawner.spawned.length > 0);
    socket.destroy();
    daemon.signals.emit("SIGTERM");
    await daemon.exit;

    expect(spawner.spawned[0]?.options.cwd).toBe(home);
  });

  it.each(["SIGTERM", "SIGHUP"])("on %s the daemon stops as on shutdown: its socket closes, run/ptyd.lock is released, and it exits 0", async (signal) => {
    const daemon = serve(await freshDeskHome());
    await until(() => answers(daemon.socket));
    const held = await exists(daemon.lockFile);

    daemon.signals.emit(signal);

    expect(await daemon.exit).toBe(0);
    expect(held).toBe(true);
    expect(await exists(daemon.lockFile)).toBe(false);
    expect(await answers(daemon.socket)).toBe(false);
  });

  it.each(["SIGTERM", "SIGHUP"])("a %s that arrives while the daemon is still starting stops it once it listens", async (signal) => {
    const daemon = serve(await freshDeskHome());

    daemon.signals.emit(signal);

    expect(await daemon.exit).toBe(0);
    expect(await exists(daemon.lockFile)).toBe(false);
    expect(await answers(daemon.socket)).toBe(false);
  });

  it("the daemon's lock records its pid, its build, the protocol range and when it started (§7.1)", async () => {
    const daemon = serve(await freshDeskHome());
    await until(() => answers(daemon.socket));

    const recorded = JSON.parse(await readFile(daemon.lockFile, "utf8")) as Record<string, unknown>;
    daemon.signals.emit("SIGTERM");
    await daemon.exit;

    expect(recorded).toEqual({ pid: process.pid, build: VERSION, protocol: [PROTOCOL_MIN, PROTOCOL_MAX], startedAt: expect.any(String) });
  });

  it.each([
    ["~/.desk is a symbolic link", async (deskHome: string) => {
      const link = join(dirname(deskHome), ".desk-link");
      await symlink(deskHome, link);
      return { deskHome: link };
    }],
    ["~/.desk has group bits (0750)", async (deskHome: string) => {
      await chmod(deskHome, 0o750);
      return { deskHome };
    }],
    ["~/.desk has other bits (0701)", async (deskHome: string) => {
      await chmod(deskHome, 0o701);
      return { deskHome };
    }],
    ["~/.desk belongs to another user", async (deskHome: string) => ({ deskHome, uid: (UID ?? 501) + 1 })],
    ["run/ is a symbolic link", async (deskHome: string) => {
      const elsewhere = join(dirname(deskHome), "elsewhere");
      await mkdir(elsewhere, { mode: 0o700 });
      await rm(join(deskHome, "run"), { recursive: true });
      await symlink(elsewhere, join(deskHome, "run"));
      return { deskHome };
    }],
    ["run/ has group bits (0770)", async (deskHome: string) => {
      await chmod(join(deskHome, "run"), 0o770);
      return { deskHome };
    }],
  ])("the daemon refuses to start when ~/.desk is a symlink, not 0700, or not yours (%s)", async (_label, prepare) => {
    const prepared: { deskHome: string; uid?: number } = await prepare(await freshDeskHome());
    const order: string[] = [];

    const daemon = serve(prepared.deskHome, { order, ...(prepared.uid === undefined ? {} : { uid: prepared.uid }) });

    expect(await daemon.exit).toBe(1);
    expect(order).toEqual([]);
    expect(await exists(daemon.lockFile)).toBe(false);
    expect(await exists(daemon.socket)).toBe(false);
  });

  it("a second daemon exits when a live daemon holds the lock", async () => {
    const deskHome = await freshDeskHome();
    const run = join(deskHome, "run");
    await writeFile(join(run, "ptyd.lock"), JSON.stringify({ pid: 4242, build: "0.3.0", startedAt: new Date(T0).toISOString() }), { mode: 0o600 });
    const processes = new FakeProcessInfo([4242]);
    processes.started.set(4242, T0);

    const daemon = serve(deskHome, { lock: new NodeInstanceLock(run, { build: VERSION }, { processes }) });

    expect(await daemon.exit).toBe(0);
    expect(await exists(daemon.socket)).toBe(false);
  });

  it("a dead daemon's lock is reclaimed", async () => {
    const deskHome = await freshDeskHome();
    const run = join(deskHome, "run");
    await writeFile(join(run, "ptyd.lock"), JSON.stringify({ pid: 4242, build: "0.3.0", startedAt: new Date(T0).toISOString() }), { mode: 0o600 });

    const daemon = serve(deskHome, { lock: new NodeInstanceLock(run, { build: VERSION }, { processes: new FakeProcessInfo() }) });
    await until(() => answers(daemon.socket));
    const holder = JSON.parse(await readFile(daemon.lockFile, "utf8")) as { pid: number };
    daemon.signals.emit("SIGTERM");

    expect(await daemon.exit).toBe(0);
    expect(holder.pid).toBe(process.pid);
  });

  it("the daemon sets umask 077 before it takes its lock", async () => {
    const order: string[] = [];
    const locks = new FakeInstanceLock();
    const lock: InstanceLock = {
      acquire: (name) => {
        order.push(`lock ${name}`);
        return locks.acquire(name);
      },
      holder: (name) => locks.holder(name),
    };

    const daemon = serve(await freshDeskHome(), { order, lock });
    await until(() => answers(daemon.socket));
    daemon.signals.emit("SIGTERM");
    await daemon.exit;

    expect(order).toEqual(["umask 77", "lock ptyd"]);
    expect(locks.released).toEqual(["ptyd"]);
  });
});
