import { homedir } from "node:os";
import { join } from "node:path";
import { DESK_EXTENSION_ID, focusGuardOn, runWatch } from "@desk/core";
import { CdpBrowserConnector, CdpTargetWatch, HttpDevTools, NodeChromeProcess, NodeChromeProfile } from "@desk/chrome";
import { NodeGuardedEndpoint } from "@desk/gateway";
import { FileConfigStore, NodeInstanceLock, NodeProcessInfo, NodeTextFiles, SystemClock, type FileLogSink } from "@desk/node";
import { UnixDaemonClient } from "./daemon-client.ts";
import { DaemonExtensionBridge } from "./extension-bridge.ts";

/**
 * `desk watch` (docs/IMPLEMENTATION.md §6.4), which `desk` starts detached: core's watch over the guarded endpoint and
 * the Chrome adapters, under `run/watch.lock` recording this build, until `until` settles (SIGTERM or SIGHUP). 65
 * without a config. It talks to the service worker through the daemon as a `watch` client: the focus guard's active
 * tab, the windows for the idle quit, and the automatic panel opens.
 */
export async function watchCommand(input: {
  env: NodeJS.ProcessEnv;
  platform: string;
  deskHome: string;
  version: string;
  until: Promise<void>;
  /** `logs/watch.log`, which the command's crash handler writes too. */
  log: FileLogSink;
}): Promise<number> {
  const config = await new FileConfigStore(input.deskHome).load();
  if (config === null) return 65;
  const daemon = new UnixDaemonClient(join(input.deskHome, "run", "ptyd.sock"), input.version);
  const bridge = new DaemonExtensionBridge(daemon, "watch");
  const log = input.log;
  const code = await runWatch(
    {
      lock: new NodeInstanceLock(join(input.deskHome, "run"), { build: input.version }),
      endpoint: new NodeGuardedEndpoint({
        port: config.gateway.port,
        rawPort: config.chrome.port,
        extensionId: DESK_EXTENSION_ID,
        focusGuard: focusGuardOn(config.gateway.focusGuard),
        activeTab: () => bridge.tabCurrent(),
      }),
      clock: new SystemClock(),
      devTools: new HttpDevTools(),
      targets: new CdpTargetWatch({ extensionId: DESK_EXTENSION_ID }),
      browser: new CdpBrowserConnector(),
      bridge,
      daemon,
      chrome: new NodeChromeProcess({ app: config.chrome.app, platform: input.platform, env: input.env }),
      profile: new NodeChromeProfile(config.chrome.userDataDir),
      processes: new NodeProcessInfo(),
      files: new NodeTextFiles(),
      log,
    },
    { config, deskHome: input.deskHome, home: input.env.HOME ?? homedir(), platform: input.platform, extensionId: DESK_EXTENSION_ID },
    input.until,
  );
  await log.flushed();
  return code;
}
