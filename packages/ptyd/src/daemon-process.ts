import { access, lstat, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { Daemon, PROTOCOL_MAX, PROTOCOL_MIN, planPaneShell, type InstanceLock, type PtySpawner } from "@desk/core";
import { FileConfigStore, NodeInstanceLock, NodeLoginShell, NodeTextFiles, NodeTmux, SystemClock, assertPathAllowed } from "@desk/node";
import { UnixMessageServer } from "./message-server.ts";

/** Where tmux usually is, when the config names none (§7.4). */
const TMUX_CANDIDATES = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"];

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
};

function errorCode(err: unknown): string | undefined {
  return err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

async function executable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
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
 * SIGHUP to its shells, the socket closed, the lock released, exit 0. Each pane's shell is planned at its spawn.
 */
export async function serveDaemon(input: ServeDaemonInput): Promise<number> {
  const { deskHome, env, version } = input;
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

  const home = env.HOME ?? userInfo().homedir;
  const files = new NodeTextFiles();
  const store = new FileConfigStore(deskHome);
  const server = new UnixMessageServer(join(run, "ptyd.sock"));
  let stopped: (code: number) => void = () => undefined;
  const done = new Promise<number>((resolve) => {
    stopped = resolve;
  });
  const daemon = new Daemon({
    spawner: input.spawner,
    clock: new SystemClock(),
    build: version,
    shellFor: async (pane) => {
      const config = await store.load();
      if (config === null) throw new Error("no config.json");
      let tmux: NodeTmux | null = null;
      for (const candidate of config.terminal.tmux === null ? TMUX_CANDIDATES : [config.terminal.tmux]) {
        if (await executable(candidate)) {
          tmux = new NodeTmux(candidate, env);
          break;
        }
      }
      return planPaneShell({ pane, config, deskHome, home, parent: env, version, tmux, files, loginShell: new NodeLoginShell() });
    },
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
  input.signals.once("SIGTERM", () => daemon.stop());
  input.signals.once("SIGHUP", () => daemon.stop());
  return done;
}
