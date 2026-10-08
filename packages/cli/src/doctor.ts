import { join } from "node:path";
import { doctor, formatDoctor, type Prompter, type VersionInfo } from "@desk/core";
import { CdpAutofillProbe, HttpDevTools, NodeChromeProcess, NodeChromeProfile, NodeNativeHostDir, openWebSocket } from "@desk/chrome";
import {
  FileConfigStore,
  NodeAppVersions,
  NodeInstanceLock,
  NodeListenerInfo,
  NodeLoginShell,
  NodePathModes,
  NodeTextFiles,
  NodeTmux,
  SystemClock,
  findGh,
  findTmux,
} from "@desk/node";
import { mainChromeUserDataDir } from "./import.ts";
import { DESK_REPO, GhProvenance } from "./provenance.ts";
import { UnixDaemonClient } from "./daemon-client.ts";
import type { CommandResult } from "./install.ts";

/**
 * `desk doctor [--fix] [--autofill-probe]` (docs/IMPLEMENTATION.md §15.2): core's rows over the Node and Chrome adapters;
 * never online. The autofill probe asks you on the terminal, so it runs only when asked.
 */
export async function doctorCommand(input: {
  env: NodeJS.ProcessEnv;
  platform: string;
  home: string;
  deskHome: string;
  info: VersionInfo;
  fix: boolean;
  autofillProbe?: boolean;
  prompter?: Prompter;
  say?: (line: string) => void;
}): Promise<CommandResult> {
  const mainDir = mainChromeUserDataDir(input.home, input.platform);
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
      gh: new GhProvenance({ gh: await findGh(input.env, input.platform), repo: DESK_REPO, env: input.env }),
      main: { profile: new NodeChromeProfile(mainDir), hosts: new NodeNativeHostDir(mainDir) },
      security: new CdpAutofillProbe({
        deskBrowser: async () => (config === null ? null : ((await new HttpDevTools().version(config.chrome.port))?.wsUrl ?? null)),
        open: openWebSocket,
        prompter: input.prompter ?? { confirm: async () => ({ ok: false, reason: "no-tty" }) },
        out: { say: input.say ?? (() => undefined) },
        clock: new SystemClock(),
      }),
    },
    { home: input.home, deskHome: input.deskHome, platform: input.platform, info: input.info, fix: input.fix, ...(input.autofillProbe === true ? { autofillProbe: true } : {}) },
  );
  return { code: result.code, message: formatDoctor(result.findings) };
}
