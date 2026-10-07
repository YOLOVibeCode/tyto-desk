import { join } from "node:path";
import { quit, type Prompter, type QuitResult } from "@desk/core";
import { CdpBrowserConnector, HttpDevTools, NodeChromeProfile } from "@desk/chrome";
import { FileConfigStore, NodeInstanceLock, NodeProcessInfo, NodeProcessSignals, NodeTextFiles, SystemClock } from "@desk/node";
import { UnixDaemonClient } from "./daemon-client.ts";

/** `desk quit [--all]`: core's quit plan (§6.3) over the Node and Chrome adapters, for the version that is running. */
export async function quitCommand(input: { deskHome: string; version: string; all: boolean; prompter: Prompter }): Promise<QuitResult> {
  return quit(
    {
      config: new FileConfigStore(input.deskHome),
      profileFor: (config) => new NodeChromeProfile(config.chrome.userDataDir),
      processes: new NodeProcessInfo(),
      devTools: new HttpDevTools(),
      browser: new CdpBrowserConnector(),
      files: new NodeTextFiles(),
      clock: new SystemClock(),
      lock: new NodeInstanceLock(join(input.deskHome, "run")),
      signals: new NodeProcessSignals(),
      daemon: new UnixDaemonClient(join(input.deskHome, "run", "ptyd.sock"), input.version),
      prompter: input.prompter,
    },
    { deskHome: input.deskHome, all: input.all },
  );
}
