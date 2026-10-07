import { join } from "node:path";
import { launch } from "@desk/core";
import { CdpBrowserConnector, HttpDevTools, NodeChromeProcess, NodeChromeProfile, NodeNativeHostDir } from "@desk/chrome";
import {
  CryptoRandom,
  FileConfigStore,
  NodeInstanceLock,
  NodePortProbe,
  NodeProcessInfo,
  NodeTextFiles,
  SystemClock,
} from "@desk/node";
import { UnixDaemonClient } from "./daemon-client.ts";
import { DaemonExtensionBridge } from "./extension-bridge.ts";
import type { CommandResult } from "./install.ts";

/** `desk`: core's launch plan (§6.1) over the Node and Chrome adapters, for the version that is running. */
export async function launchCommand(input: {
  env: NodeJS.ProcessEnv;
  platform: string;
  home: string;
  deskHome: string;
  version: string;
  appDir: string;
}): Promise<CommandResult> {
  const daemon = new UnixDaemonClient(join(input.deskHome, "run", "ptyd.sock"), input.version);
  const result = await launch(
    {
      lock: new NodeInstanceLock(join(input.deskHome, "run")),
      config: new FileConfigStore(input.deskHome),
      probe: new NodePortProbe(),
      random: new CryptoRandom(),
      clock: new SystemClock(),
      chromeFor: (config) => ({
        chrome: new NodeChromeProcess({ app: config.chrome.app, platform: input.platform, env: input.env }),
        profile: new NodeChromeProfile(config.chrome.userDataDir),
        hosts: new NodeNativeHostDir(config.chrome.userDataDir),
      }),
      processes: new NodeProcessInfo(),
      devTools: new HttpDevTools(),
      browser: new CdpBrowserConnector(),
      daemon,
      bridge: new DaemonExtensionBridge(daemon),
      files: new NodeTextFiles(),
    },
    { home: input.home, deskHome: input.deskHome, platform: input.platform, version: input.version, appDir: input.appDir },
  );
  return result.ok ? { code: 0, message: result.message } : { code: result.code, message: result.message };
}
