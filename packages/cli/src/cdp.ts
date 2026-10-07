import { cdpUrl } from "@desk/core";
import { HttpDevTools } from "@desk/chrome";
import { FileConfigStore } from "@desk/node";
import type { CommandResult } from "./install.ts";

/**
 * `desk cdp [--raw] [--ws]` (docs/IMPLEMENTATION.md §11): the guarded endpoint any CDP client should use, or with `--raw`
 * the Desk Chrome's own port; `--ws` asks the chosen endpoint for its browser WebSocket, so it needs Desk running.
 */
export async function cdpCommand(input: { deskHome: string; raw: boolean; ws: boolean }): Promise<CommandResult> {
  const config = await new FileConfigStore(input.deskHome).load();
  if (config === null) return { code: 69, message: "Desk has no config yet; run desk" };
  const port = input.raw ? config.chrome.port : config.gateway.port;
  if (!input.ws) return { code: 0, message: cdpUrl(port) };
  const version = await new HttpDevTools().version(port);
  if (version === null) return { code: 69, message: "Desk is not running; run desk" };
  return { code: 0, message: version.wsUrl };
}
