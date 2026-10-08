import { lstat, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { userInfo } from "node:os";
import { Daemon, PROTOCOL_MAX, PROTOCOL_MIN, planPaneShell, type InstanceLock, type LogSink, type PtySpawner } from "@desk/core";
import { FileConfigStore, FileLogSink, NodeInstanceLock, NodeLoginShell, NodeProcessCwd, NodeTextFiles, NodeTmux, SystemClock, assertPathAllowed, findTmux } from "@desk/node";
import { NodeLayoutStore } from "./layout-store.ts";
import { NodeTerminalMirror } from "./terminal-mirror.ts";
import { UnixMessageServer } from "./message-server.ts";

/** Where tmux usually is, when the config names none (§7.4). */
/** Where the signals that end the daemon arrive: `process` in production. */
export type DaemonSignals = { once(signal: "SIGTERM" | "SIGHUP", listener: () => void): unknown };

export type ServeDaemonInput = {
  deskHome: string;
  env: NodeJS.ProcessEnv;
  /** This daemon's version (its version.json's), for `hello` and the lock. */
  version: string;
  spawner: PtySpawner;
  /** This user's uid (`process.getuid()`), or null on a platform without one. */
  uid: number | null;
  /** Sets the process's umask (`process.umask`). */
  umask(mask: number): void;
  signals: DaemonSignals;
  /** `run/ptyd.lock`; by default it records the build, the protocol range and the start (§7.1). */
  lock?: InstanceLock;
  /** `logs/ptyd.log` by default (§4.4). */
  log?: LogSink;
};

function errorCode(err: unknown): string | undefined {
  return err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

/** Whether `dir` is a directory the daemon may trust (§4.1, §7.1): not a symlink, owned by `uid`, no group or other bits. */
export async function trustedDir(dir: string, uid: number | null): Promise<boolean> {
  const st = await lstat(dir).catch((err: unknown) => {
    if (errorCode(err) === "ENOENT" || errorCode(err) === "ENOTDIR") return null;
    throw err;
  });
  if (st === null || st.isSymbolicLink() || !st.isDirectory()) return false;
  if (uid !== null && st.uid !== uid) return false;
  return (st.mode & 0o077) === 0;
}

/**
 * `desk-ptyd`'s process (docs/IMPLEMENTATION.md §7.1, D94, D97), with its PTY adapter passed in so the offline suite
 * reaches all of it but the PTY. It refuses to start (1) unless `~/.desk` and `run/` are directories owned by this user,
 * with no group or other bits and not symbolic links; sets umask 077; takes `run/ptyd.lock` (a live daemon holds it:
 * this one exits 0); then serves `run/ptyd.sock` until a `shutdown`, or SIGTERM or SIGHUP, which end it the same way:
 * SIGHUP to its shells, the socket closed, the lock released, exit 0. A signal that arrives while it is still starting
 * (the socket can accept connections before its listen finishes) stops it once it listens. Each pane's shell is planned
 * at its spawn.
 */
export async function serveDaemon(input: ServeDaemonInput): Promise<number> {
  const { deskHome, env, version } = input;
  // Listening for SIGTERM and SIGHUP from the first line: a stop that comes during start-up is never lost.
  let listening: Daemon | null = null;
  let stopAsked = false;
  const stop = () => {
    if (listening !== null) listening.stop();
    else stopAsked = true;
  };
  input.signals.once("SIGTERM", stop);
  input.signals.once("SIGHUP", stop);
  const run = join(deskHome, "run");
  await assertPathAllowed(run);
  if (!(await trustedDir(deskHome, input.uid))) return 1;
  await mkdir(run, { mode: 0o700 }).catch((err: unknown) => {
    if (errorCode(err) !== "EEXIST") throw err;
  });
  if (!(await trustedDir(run, input.uid))) return 1;
  input.umask(0o077);
  const lock = await (input.lock ?? new NodeInstanceLock(run, { build: version, protocol: [PROTOCOL_MIN, PROTOCOL_MAX] })).acquire("ptyd");
  if (!lock.ok) return 0;
  if (stopAsked) {
    await lock.release();
    return 0;
  }

  const home = env.HOME ?? userInfo().homedir;
  const files = new NodeTextFiles();
  const store = new FileConfigStore(deskHome);
  // The terminal settings the daemon starts with; a pane's shell re-reads the config at its spawn.
  const startConfig = await store.load().catch(() => null);
  const server = new UnixMessageServer(join(run, "ptyd.sock"));
  let stopped: (code: number) => void = () => undefined;
  const done = new Promise<number>((resolve) => {
    stopped = resolve;
  });
  const daemon = new Daemon({
    spawner: input.spawner,
    clock: new SystemClock(),
    build: version,
    shellFor: async (pane, cwd) => {
      const config = await store.load();
      if (config === null) throw new Error("no config.json");
      const binary = await findTmux(config.terminal.tmux);
      const tmux = binary === null ? null : new NodeTmux(binary, env);
      // A directory that is gone by now (removed after the split was asked for) leaves the shell in the home directory.
      const usable = cwd !== null && (await stat(cwd).then((found) => found.isDirectory(), () => false));
      return planPaneShell({ pane, config, deskHome, home, parent: env, version, tmux, files, loginShell: new NodeLoginShell(), ...(usable ? { cwd } : {}) });
    },
    cwds: new NodeProcessCwd(),
    layouts: new NodeLayoutStore(deskHome),
    mirror: new NodeTerminalMirror(),
    scrollback: startConfig?.terminal.scrollback ?? 5_000,
    closeOnExit: startConfig?.terminal.closeOnExit ?? true,
    log: input.log ?? new FileLogSink(join(deskHome, "logs", "ptyd.log")),
    onShutdown: () => {
      void server.close().then(async () => {
        await lock.release();
        stopped(0);
      });
    },
  });
  try {
    await server.listen((peer) => daemon.connect(peer));
  } catch {
    await lock.release();
    return 1;
  }
  listening = daemon;
  if (stopAsked) daemon.stop();
  return done;
}
