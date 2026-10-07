import { join } from "node:path";
import { DESK_EXTENSION_ID, runWatch } from "@desk/core";
import { NodeGuardedEndpoint } from "@desk/gateway";
import { FileConfigStore, NodeInstanceLock } from "@desk/node";

/**
 * `desk watch` (docs/IMPLEMENTATION.md §6.4), which `desk` starts detached: core's watch plan over the guarded endpoint,
 * under `run/watch.lock` recording this build, until `until` settles (SIGTERM or SIGHUP). 65 without a config.
 */
export async function watchCommand(input: { deskHome: string; version: string; until: Promise<void> }): Promise<number> {
  const config = await new FileConfigStore(input.deskHome).load();
  if (config === null) return 65;
  return runWatch(
    {
      lock: new NodeInstanceLock(join(input.deskHome, "run"), { build: input.version }),
      endpoint: new NodeGuardedEndpoint({ port: config.gateway.port, rawPort: config.chrome.port, extensionId: DESK_EXTENSION_ID }),
    },
    input.until,
  );
}
