import { join } from "node:path";
import { DESK_EXTENSION_ID, focusGuardOn, runWatch } from "@desk/core";
import { NodeGuardedEndpoint } from "@desk/gateway";
import { FileConfigStore, NodeInstanceLock } from "@desk/node";
import { UnixDaemonClient } from "./daemon-client.ts";
import { DaemonExtensionBridge } from "./extension-bridge.ts";

/**
 * `desk watch` (docs/IMPLEMENTATION.md §6.4), which `desk` starts detached: core's watch plan over the guarded endpoint,
 * under `run/watch.lock` recording this build, until `until` settles (SIGTERM or SIGHUP). 65 without a config. The focus
 * guard asks the service worker, through the daemon as a `watch` client, which tab you are looking at.
 */
export async function watchCommand(input: { deskHome: string; version: string; until: Promise<void> }): Promise<number> {
  const config = await new FileConfigStore(input.deskHome).load();
  if (config === null) return 65;
  const bridge = new DaemonExtensionBridge(new UnixDaemonClient(join(input.deskHome, "run", "ptyd.sock"), input.version), "watch");
  return runWatch(
    {
      lock: new NodeInstanceLock(join(input.deskHome, "run"), { build: input.version }),
      endpoint: new NodeGuardedEndpoint({
        port: config.gateway.port,
        rawPort: config.chrome.port,
        extensionId: DESK_EXTENSION_ID,
        focusGuard: focusGuardOn(config.gateway.focusGuard),
        activeTab: () => bridge.tabCurrent(),
      }),
    },
    input.until,
  );
}
