import { join } from "node:path";
import { daemonRestart, deskStatus, type Prompter } from "@desk/core";
import { HttpDevTools, NodeChromeProfile } from "@desk/chrome";
import { FileConfigStore, FileLogSink, NodeInstanceLock, NodeProcessInfo } from "@desk/node";
import { UnixDaemonClient } from "./daemon-client.ts";

const daemonAt = (deskHome: string, version: string) => new UnixDaemonClient(join(deskHome, "run", "ptyd.sock"), version);

/** `desk status`: core's status over the Node and Chrome adapters. */
export async function statusCommand(input: { deskHome: string; version: string }): Promise<{ code: number; message: string }> {
  return deskStatus({
    config: new FileConfigStore(input.deskHome),
    profileFor: (config) => new NodeChromeProfile(config.chrome.userDataDir),
    processes: new NodeProcessInfo(),
    devTools: new HttpDevTools(),
    daemon: daemonAt(input.deskHome, input.version),
    lock: new NodeInstanceLock(join(input.deskHome, "run")),
  });
}

/** `desk daemon restart`, with its audit line in `logs/desk.log` on disk before the command returns. */
export async function daemonRestartCommand(input: { deskHome: string; version: string; prompter: Prompter }): Promise<{
  code: number;
  message: string;
  finish?: () => Promise<void>;
}> {
  const log = new FileLogSink(join(input.deskHome, "logs", "desk.log"));
  const result = await daemonRestart({ daemon: daemonAt(input.deskHome, input.version), prompter: input.prompter, log });
  await log.flushed();
  return result;
}
