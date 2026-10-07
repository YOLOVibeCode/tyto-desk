import { join } from "node:path";
import { DaemonExtensionBridge } from "./extension-bridge.ts";
import { UnixDaemonClient } from "./daemon-client.ts";
import type { CommandResult } from "./install.ts";

/**
 * `desk tab current` and `desk tab mine` (docs/IMPLEMENTATION.md §11): the target id of the tab you are looking at, and
 * of this pane's agent tab, which the service worker keeps in a tab group named after the pane and creates in the
 * background when it is missing. `agent-browser tab "$(desk tab mine)"` points an agent at it.
 */
export async function tabCommand(input: { deskHome: string; version: string; which: "current" | "mine"; pane: string | undefined }): Promise<CommandResult> {
  if (input.which === "mine" && (input.pane === undefined || !/^p_[0-9a-z]{10}$/.test(input.pane))) {
    return { code: 64, message: "desk tab mine runs in a Desk pane, which sets DESK_PANE" };
  }
  const bridge = new DaemonExtensionBridge(new UnixDaemonClient(join(input.deskHome, "run", "ptyd.sock"), input.version));
  const target = input.which === "current" ? await bridge.tabCurrent() : await bridge.tabMine(input.pane ?? "");
  return target === null ? { code: 69, message: "Desk is not running, or its extension did not answer; run desk" } : { code: 0, message: target };
}
