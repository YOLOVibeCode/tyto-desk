import { join } from "node:path";
import { doctor, formatDoctor, type VersionInfo } from "@desk/core";
import { HttpDevTools, NodeChromeProcess, NodeChromeProfile, NodeNativeHostDir } from "@desk/chrome";
import {
  FileConfigStore,
  NodeAppVersions,
  NodeInstanceLock,
  NodeListenerInfo,
  NodeLoginShell,
  NodePathModes,
  NodeTextFiles,
  NodeTmux,
  findTmux,
} from "@desk/node";
import { UnixDaemonClient } from "./daemon-client.ts";
import type { CommandResult } from "./install.ts";

/** `desk doctor [--fix]` (docs/IMPLEMENTATION.md §15.2): core's rows over the Node and Chrome adapters; never online. */
export async function doctorCommand(input: {
  env: NodeJS.ProcessEnv;
  platform: string;
  home: string;
  deskHome: string;
  info: VersionInfo;
  fix: boolean;
}): Promise<CommandResult> {
  const store = new FileConfigStore(input.deskHome);
  const config = await store.load().catch(() => null);
  const binary = await findTmux(config?.terminal.tmux ?? null);
  const result = await doctor(
    {
      config: store,
      files: new NodeTextFiles(),
      modes: new NodePathModes(),
      versions: new NodeAppVersions(input.deskHome),
      chromeFor: (loaded) => ({
        chrome: new NodeChromeProcess({ app: loaded.chrome.app, platform: input.platform, env: input.env }),
        profile: new NodeChromeProfile(loaded.chrome.userDataDir),
        hosts: new NodeNativeHostDir(loaded.chrome.userDataDir),
      }),
      devTools: new HttpDevTools(),
      listeners: new NodeListenerInfo(),
      lock: new NodeInstanceLock(join(input.deskHome, "run")),
      daemon: new UnixDaemonClient(join(input.deskHome, "run", "ptyd.sock"), input.info.version),
      tmux: binary === null ? null : new NodeTmux(binary, input.env),
      shell: new NodeLoginShell({ env: input.env }),
    },
    { home: input.home, deskHome: input.deskHome, platform: input.platform, info: input.info, fix: input.fix },
  );
  return { code: result.code, message: formatDoctor(result.findings) };
}
