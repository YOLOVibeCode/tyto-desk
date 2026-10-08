import { join } from "node:path";
import { uninstall, type Prompter } from "@desk/core";
import { HttpDevTools, NodeNativeHostDir } from "@desk/chrome";
import {
  FileConfigStore,
  NodeInstanceLock,
  NodeLaunchAgents,
  NodeProcessSignals,
  NodeTextFiles,
  NodeTreeRemover,
  SystemClock,
} from "@desk/node";
import { UnixDaemonClient } from "./daemon-client.ts";
import type { CommandResult } from "./install.ts";

/** `desk uninstall [--profile]` (docs/IMPLEMENTATION.md §15.4): core's plan over the Node and Chrome adapters. */
export async function uninstallCommand(input: { home: string; deskHome: string; version: string; profile: boolean; prompter: Prompter }): Promise<CommandResult> {
  return uninstall(
    {
      config: new FileConfigStore(input.deskHome),
      files: new NodeTextFiles(),
      trees: new NodeTreeRemover(),
      hostsFor: (config) => new NodeNativeHostDir(config.chrome.userDataDir),
      agents: new NodeLaunchAgents({ home: input.home, uid: process.getuid?.() ?? 0 }),
      lock: new NodeInstanceLock(join(input.deskHome, "run")),
      signals: new NodeProcessSignals(),
      daemon: new UnixDaemonClient(join(input.deskHome, "run", "ptyd.sock"), input.version),
      prompter: input.prompter,
      devTools: new HttpDevTools(),
      clock: new SystemClock(),
    },
    { home: input.home, deskHome: input.deskHome, profile: input.profile },
  );
}
