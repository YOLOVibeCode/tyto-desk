import { access, lstat, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { Daemon, planPaneShell } from "@desk/core";
import { FileConfigStore, NodeInstanceLock, NodeLoginShell, NodeTextFiles, NodeTmux, SystemClock } from "@desk/node";
import { UnixMessageServer } from "./message-server.ts";
import { NodePtySpawner } from "./node-pty-spawner.ts";

/** Where tmux usually is, when the config names none (§7.4). */
const TMUX_CANDIDATES = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"];

async function executable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}

/**
 * Whether `dir` is a directory the daemon may trust (§7.1): not a symlink, owned by this user, and 0700.
 */
async function trusted(dir: string): Promise<boolean> {
  const st = await lstat(dir).catch(() => null);
  if (st === null || st.isSymbolicLink() || !st.isDirectory()) return false;
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return false;
  return (st.mode & 0o077) === 0;
}

/**
 * `desk-ptyd` (docs/IMPLEMENTATION.md §7.1; slice 1c: one daemon, panes without a mirror). Started only by a native
 * host, detached, with stdio ignored and an explicit environment. It checks `~/.desk` and `run/` (owned by this user,
 * 0700, not symlinks), sets umask 077, takes `run/ptyd.lock` (a live daemon wins: this one exits 0), and serves
 * `run/ptyd.sock` until a `shutdown`. Each pane's shell is planned at its spawn: the config's shell or the account's,
 * the pane environment, and the agent-variable gate.
 */
export async function runDaemon(input: { deskHome: string; env: NodeJS.ProcessEnv; version: string }): Promise<number> {
  const { deskHome, env, version } = input;
  const run = join(deskHome, "run");
  await mkdir(run, { recursive: true, mode: 0o700 });
  if (!(await trusted(deskHome)) || !(await trusted(run))) return 1;
  process.umask(0o077);
  const lock = await new NodeInstanceLock(run, { build: version }).acquire("ptyd");
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
    spawner: new NodePtySpawner(),
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
  return done;
}
