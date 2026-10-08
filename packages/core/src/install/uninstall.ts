import { DESK_SKILL } from "../agents/skill.ts";
import { sha256Hex } from "../bytes/sha256.ts";
import type { DeskConfig } from "../config/schema.ts";
import { NATIVE_HOST_NAME } from "../extension/desk-extension.ts";
import { pollUntil } from "../launch/poll.ts";
import type { Clock } from "../ports/clock.ts";
import type { ConfigStore } from "../ports/config-store.ts";
import type { DaemonClient } from "../ports/daemon-client.ts";
import type { DevToolsHttp } from "../ports/dev-tools-http.ts";
import type { InstanceLock } from "../ports/instance-lock.ts";
import type { LaunchAgents } from "../ports/launch-agents.ts";
import type { NativeHostDir } from "../ports/native-host-dir.ts";
import type { ProcessSignals } from "../ports/process-signals.ts";
import type { Prompter } from "../ports/prompter.ts";
import type { TextFiles } from "../ports/text-files.ts";
import type { TreeRemover } from "../ports/tree-remover.ts";
import { TMUX_DESK_LINE } from "../pty/agent-env.ts";
import { WEB_ACCESS_DESK_STEP, isManagedFile } from "./extras.ts";
import { parseInstalled } from "./installed.ts";

export type UninstallPorts = {
  config: ConfigStore;
  files: TextFiles;
  trees: TreeRemover;
  hostsFor(config: DeskConfig): NativeHostDir;
  agents: LaunchAgents;
  lock: InstanceLock;
  signals: ProcessSignals;
  daemon: DaemonClient;
  prompter: Prompter;
  devTools: DevToolsHttp;
  clock: Clock;
};

/** §6.5: 64 needs an interactive terminal · 75 the Desk Chrome runs · 77 the operator declined. */
export type UninstallResult = { code: 0 | 64 | 75 | 77; message: string };

const TMUX_COMMENT = "# Desk: tmux sessions created from a Desk pane keep the Desk browser's variables.";
const WATCH_STOP_MS = 10_000;

/** The text without the exact line (and Desk's comment above it), or `null` when it does not hold the line. */
function withoutLine(text: string, line: string, comment: string | null): string | null {
  const lines = text.split("\n");
  const at = lines.findIndex((entry) => entry === line);
  if (at < 0) return null;
  const from = comment !== null && at > 0 && lines[at - 1] === comment ? at - 1 : at;
  lines.splice(from, at - from + 1);
  return lines.join("\n");
}

/**
 * `desk uninstall [--profile]` (docs/IMPLEMENTATION.md §15.4), after you confirm, and never while the Desk Chrome runs:
 * stops `desk watch` and, after you confirm, the daemon; removes the launchers, `~/.desk/bin`, the Desk host manifest,
 * and what installed.json records install wrote (an edited skill is kept and named): the skills, the web-access step,
 * the exact tmux line, Desk.app and the login agent; removes `~/.desk` if you agree, and the Desk profile only with
 * `--profile` and a second confirmation. Nothing install did not record is touched.
 */
export async function uninstall(ports: UninstallPorts, input: { home: string; deskHome: string; profile: boolean }): Promise<UninstallResult> {
  const home = input.home.replace(/\/+$/, "");
  const deskHome = input.deskHome.replace(/\/+$/, "");
  const config = await ports.config.load().catch(() => null);
  if (config !== null && (await ports.devTools.version(config.chrome.port)) !== null) {
    return { code: 75, message: "the Desk Chrome is running; run desk quit, then desk uninstall" };
  }
  const consent = await ports.prompter.confirm("Uninstall Desk? Your terminals end only if you also stop the terminal daemon.");
  if (!consent.ok) return { code: 64, message: "desk uninstall needs an interactive terminal to ask you; nothing was uninstalled" };
  if (!consent.yes) return { code: 77, message: "Nothing was uninstalled: you declined" };
  const notes: string[] = [];

  const watch = await ports.lock.holder("watch");
  if (watch !== null) {
    await ports.signals.terminate(watch.pid);
    await pollUntil(ports.clock, WATCH_STOP_MS, 100, async () => ((await ports.lock.holder("watch")) === null ? true : null));
  }
  const daemon = await ports.prompter.confirm("Stop the terminal daemon? Every shell in a Desk pane ends; tmux sessions keep running.");
  if (daemon.ok && daemon.yes) {
    const opened = await ports.daemon.open("cli");
    if (opened.ok) {
      try {
        await opened.session.notify({ type: "shutdown", mode: "stop" });
      } finally {
        opened.session.close();
      }
    }
  }

  const installed = parseInstalled((await ports.files.read(`${deskHome}/installed.json`)) ?? "");
  const recorded = (installed?.files ?? []).filter(isManagedFile);
  for (const entry of recorded) {
    switch (entry.kind) {
      case "skill": {
        const text = await ports.files.read(entry.path);
        if (text === null) break;
        if (text === DESK_SKILL || sha256Hex(text) === entry.sha256) await ports.files.remove(entry.path);
        else notes.push(`kept your edited ${entry.path}`);
        break;
      }
      case "rule-step": {
        const text = await ports.files.read(entry.path);
        const next = text === null ? null : withoutLine(text, WEB_ACCESS_DESK_STEP.trimEnd(), null);
        if (next !== null) await ports.files.write(entry.path, next, 0o644);
        break;
      }
      case "tmux-line": {
        const text = await ports.files.read(entry.path);
        const next = text === null ? null : withoutLine(text, TMUX_DESK_LINE, TMUX_COMMENT);
        if (next !== null) await ports.files.write(entry.path, next, 0o644);
        break;
      }
      case "desk-app":
        await ports.trees.remove(entry.path);
        break;
      case "launch-agent":
        await ports.agents.remove(entry.label);
        break;
      case "native-host":
        // A host desk import native-hosts copied (§14).
        if (config !== null) await ports.hostsFor(config).remove(entry.name);
        break;
      default: {
        const never: never = entry;
        throw new Error(`unknown recorded file ${JSON.stringify(never)}`);
      }
    }
  }

  await ports.files.remove(`${home}/.local/bin/desk`);
  await ports.trees.remove(`${deskHome}/bin`);
  if (config !== null) await ports.hostsFor(config).remove(NATIVE_HOST_NAME);

  const keep = await ports.prompter.confirm(`Remove ${deskHome}: your config, layout, logs and installed versions?`);
  if (keep.ok && keep.yes) await ports.trees.remove(deskHome);
  else notes.push(`kept ${deskHome}`);

  if (input.profile && config !== null) {
    const first = await ports.prompter.confirm(`Delete the Desk Chrome's profile (${config.chrome.userDataDir}): its logins, cookies, history and saved passwords?`);
    const second = first.ok && first.yes ? await ports.prompter.confirm("Deleting the profile cannot be undone. Delete it?") : null;
    if (second?.ok === true && second.yes) await ports.trees.remove(config.chrome.userDataDir);
    else notes.push("kept the Desk Chrome's profile");
  }

  return { code: 0, message: ["Desk is uninstalled", ...notes].join("; ") };
}
