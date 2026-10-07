import type { DeskConfig } from "../config/schema.ts";
import { pollUntil } from "../launch/poll.ts";
import type { BrowserConnector } from "../ports/browser-connector.ts";
import type { ChromeProfile } from "../ports/chrome-profile.ts";
import type { Clock } from "../ports/clock.ts";
import type { ConfigStore } from "../ports/config-store.ts";
import type { DaemonClient } from "../ports/daemon-client.ts";
import type { DevToolsHttp } from "../ports/dev-tools-http.ts";
import type { InstanceLock } from "../ports/instance-lock.ts";
import type { LogSink } from "../ports/log-sink.ts";
import type { ProcessInfo } from "../ports/process-info.ts";
import type { ProcessSignals } from "../ports/process-signals.ts";
import type { Prompter } from "../ports/prompter.ts";
import type { TextFiles } from "../ports/text-files.ts";

export type QuitPorts = {
  config: ConfigStore;
  profileFor(config: DeskConfig): ChromeProfile;
  processes: ProcessInfo;
  devTools: DevToolsHttp;
  browser: BrowserConnector;
  files: TextFiles;
  clock: Clock;
  lock: InstanceLock;
  signals: ProcessSignals;
  daemon: DaemonClient;
  prompter: Prompter;
  /** `desk.log`, for the consent audit line (§6.3). */
  log: LogSink;
};

export type QuitInput = { deskHome: string; all: boolean };

/**
 * §6.5's codes. `finish`, when present, stops the terminal daemon: the CLI calls it after printing the message, because
 * the daemon's shells end with it, and `desk quit --all` may run in one of them.
 */
export type QuitResult = { code: 0 | 64 | 75 | 77; message: string; finish?: () => Promise<void> };

export const QUIT_ALL_QUESTION =
  "Quit the Desk Chrome and stop the terminal daemon and desk watch? Plain shells end; tmux sessions keep running.";

const NOT_RUNNING = "The Desk Chrome is not running.";
const CLOSED = "Closed the Desk Chrome. Its pages were not asked about unsaved changes (Cmd+Q asks).";

/** §6.6's budget for Browser.close until the port closes. */
const CLOSE_MS = 10_000;
const POLL_MS = 100;

type ChromeOutcome = { ok: true; closed: boolean; message: string } | { ok: false; message: string };

/**
 * `desk quit` (docs/IMPLEMENTATION.md §6.3). It closes the Desk Chrome through CDP `Browser.close`, never a signal,
 * after writing `run/quit.marker` so `desk watch` does not relaunch it, and waits up to 10 s for the port to close. It
 * closes only a Chrome whose Desk singleton is alive. Shells keep running. `--all`, after the operator confirms on a
 * terminal, also stops `desk watch` (SIGTERM to the pid holding `run/watch.lock`) and then the daemon, last.
 */
export async function quit(ports: QuitPorts, input: QuitInput): Promise<QuitResult> {
  const result = await quitPlan(ports, input);
  // §6.3: each consent operation writes one audit line with its exit code, never names or values.
  if (input.all) ports.log.write({ event: "consent", operation: "quit-all", exit: result.code });
  return result;
}

async function quitPlan(ports: QuitPorts, input: QuitInput): Promise<QuitResult> {
  if (input.all) {
    const consent = await ports.prompter.confirm(QUIT_ALL_QUESTION);
    if (!consent.ok) return { code: 64, message: "desk quit --all needs an interactive terminal to ask you first" };
    if (!consent.yes) return { code: 77, message: "Nothing was changed." };
  }

  const closing = await closeChrome(ports, input.deskHome);
  if (!closing.ok) return { code: 75, message: closing.message };
  const lines = [closing.message];
  if (!input.all) {
    if (closing.closed) lines.push("Shells keep running in the terminal daemon; tmux keeps Claude.");
    return { code: 0, message: lines.join(" ") };
  }

  if (await stopWatch(ports)) lines.push("Stopped desk watch.");
  const opened = await ports.daemon.open("cli");
  if (!opened.ok) {
    lines.push(
      opened.reason === "unreachable"
        ? "The terminal daemon was not running."
        : "The terminal daemon speaks another protocol version, so it was left running.",
    );
    return { code: 0, message: lines.join(" ") };
  }
  lines.push("Stopping the terminal daemon: plain shells end, tmux sessions keep running.");
  const session = opened.session;
  return {
    code: 0,
    message: lines.join(" "),
    finish: async () => {
      try {
        await session.notify({ type: "shutdown", mode: "stop" });
      } finally {
        session.close();
      }
    },
  };
}

async function closeChrome(ports: QuitPorts, deskHome: string): Promise<ChromeOutcome> {
  const config = await ports.config.load();
  if (config === null) return { ok: true, closed: false, message: NOT_RUNNING };
  const port = config.chrome.port;
  const singleton = await ports.profileFor(config).singleton();
  const deskAlive = singleton !== null && (await ports.processes.alive(singleton.pid));
  const version = await ports.devTools.version(port);
  if (version === null) {
    return deskAlive
      ? { ok: false, message: "the Desk Chrome is running without its debugging port; quit it with Cmd+Q" }
      : { ok: true, closed: false, message: NOT_RUNNING };
  }
  if (!deskAlive) return { ok: false, message: `port ${port} is held by another program; desk quit closes only the Desk Chrome` };

  await ports.files.write(`${deskHome}/run/quit.marker`, `${ports.clock.now()}\n`, 0o600);
  const connected = await ports.browser.connect(version.wsUrl);
  if (!connected.ok) {
    return { ok: false, message: `the Desk Chrome answered on port ${port} but its browser WebSocket did not; quit it with Cmd+Q` };
  }
  try {
    await connected.session.lifecycle.close();
  } finally {
    connected.session.close();
  }
  const gone = await pollUntil(ports.clock, CLOSE_MS, POLL_MS, async () => ((await ports.devTools.version(port)) === null ? true : null));
  if (gone === null) return { ok: false, message: "the Desk Chrome did not close within 10 s; quit it with Cmd+Q" };
  return { ok: true, closed: true, message: CLOSED };
}

/** Stops the `desk watch` that holds `run/watch.lock`; `false` when none does (the lock taken is released at once). */
async function stopWatch(ports: QuitPorts): Promise<boolean> {
  const attempt = await ports.lock.acquire("watch");
  if (attempt.ok) {
    await attempt.release();
    return false;
  }
  return ports.signals.terminate(attempt.heldBy);
}
