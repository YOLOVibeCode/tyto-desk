import type { DeskConfig } from "../config/schema.ts";
import type { ChromeProfile } from "../ports/chrome-profile.ts";
import type { ConfigStore } from "../ports/config-store.ts";
import type { DaemonClient } from "../ports/daemon-client.ts";
import type { DevToolsHttp } from "../ports/dev-tools-http.ts";
import type { InstanceLock } from "../ports/instance-lock.ts";
import type { LogSink } from "../ports/log-sink.ts";
import type { ProcessInfo } from "../ports/process-info.ts";
import type { Prompter } from "../ports/prompter.ts";
import type { Panes } from "../protocol/messages.ts";

export type StatusPorts = {
  config: ConfigStore;
  profileFor(config: DeskConfig): ChromeProfile;
  processes: ProcessInfo;
  devTools: DevToolsHttp;
  daemon: DaemonClient;
  lock: InstanceLock;
};

/** Labels padded to one column. */
const line = (label: string, text: string) => `${`${label}:`.padEnd(10)}${text}`;

/**
 * `desk status` (SPEC §5.1): the Desk Chrome (pid, port, version), the guarded endpoint and the `desk watch` serving it,
 * the daemon and the service worker, the panels' windows, the pane ids with alive or exited, and whether agents are
 * paused. Never a title, a directory, or anything a page or a shell wrote.
 */
export async function deskStatus(ports: StatusPorts): Promise<{ code: 0; message: string }> {
  const config = await ports.config.load();
  if (config === null) return { code: 0, message: "Desk has no config yet; run desk" };
  const lines: string[] = [];

  const singleton = await ports.profileFor(config).singleton();
  const alive = singleton !== null && (await ports.processes.alive(singleton.pid));
  const version = await ports.devTools.version(config.chrome.port);
  if (alive && version !== null && singleton !== null) {
    lines.push(line("Chrome", `running (pid ${singleton.pid}, port ${config.chrome.port}, ${version.browser})`));
  } else if (version !== null) {
    lines.push(line("Chrome", `not running; another program holds port ${config.chrome.port}`));
  } else {
    lines.push(line("Chrome", alive ? "running without its debugging port; quit it with Cmd+Q" : "not running"));
  }

  const opened = await ports.daemon.open("cli");
  let panes: Panes | null = null;
  if (opened.ok) {
    try {
      const reply = await opened.session.request({ type: "list" });
      panes = reply?.type === "panes" ? reply : null;
    } finally {
      opened.session.close();
    }
  }
  const watch = await ports.lock.holder("watch");
  const clients = panes?.gatewayClients ?? 0;
  lines.push(
    line(
      "Guarded",
      watch === null
        ? `port ${config.gateway.port}, desk watch not running`
        : `port ${config.gateway.port}, served by desk watch (pid ${watch.pid}, ${watch.build ?? "unknown build"}), ${clients} client${clients === 1 ? "" : "s"}`,
    ),
  );

  if (!opened.ok) {
    lines.push(line("Daemon", opened.reason === "stale" ? "running another protocol version: desk daemon restart" : "not running"));
    return { code: 0, message: lines.join("\n") };
  }
  lines.push(line("Daemon", `running; service worker ${panes?.sw.connected === true ? "connected" : "not connected"}`));
  const windows = panes?.panels.map((panel) => panel.window) ?? [];
  lines.push(line("Panels", windows.length === 0 ? "none" : `window${windows.length === 1 ? "" : "s"} ${windows.join(", ")}`));
  const listed = panes?.panes ?? [];
  lines.push(line("Panes", listed.length === 0 ? "none" : listed.map((pane) => `${pane.id} ${pane.alive ? "alive" : "exited"}`).join(", ")));
  lines.push(line("Agents", panes?.paused === true ? "paused" : "allowed"));
  return { code: 0, message: lines.join("\n") };
}

export const RESTART_QUESTION = "Restart the terminal daemon? Plain shells end; tmux sessions survive and re-attach.";

/**
 * `desk daemon restart` (SPEC §5.1, §6.3): after the operator confirms on a terminal, the daemon is asked to shut down
 * for a restart. `finish` sends it, after the CLI printed the message, because the daemon's shells end with it and this
 * may run in one of them; the next panel connection starts the current version's daemon. One audit line.
 */
export async function daemonRestart(ports: { daemon: DaemonClient; prompter: Prompter; log: LogSink }): Promise<{
  code: 0 | 64 | 69 | 77;
  message: string;
  finish?: () => Promise<void>;
}> {
  const consent = await ports.prompter.confirm(RESTART_QUESTION);
  const audit = (exit: number) => ports.log.write({ event: "consent", operation: "daemon-restart", exit });
  if (!consent.ok) {
    audit(64);
    return { code: 64, message: "desk daemon restart needs an interactive terminal to ask you first" };
  }
  if (!consent.yes) {
    audit(77);
    return { code: 77, message: "Nothing was changed." };
  }
  const opened = await ports.daemon.open("cli");
  if (!opened.ok) {
    audit(69);
    return { code: 69, message: "The terminal daemon is not running." };
  }
  audit(0);
  const session = opened.session;
  return {
    code: 0,
    message: "Restarting the terminal daemon: plain shells end, tmux sessions survive and re-attach.",
    finish: async () => {
      try {
        await session.notify({ type: "shutdown", mode: "restart" });
      } finally {
        session.close();
      }
    },
  };
}
