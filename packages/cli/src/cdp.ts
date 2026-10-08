import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cdpUrl, restoreKeyWarning } from "@desk/core";
import { HttpDevTools } from "@desk/chrome";
import { FileConfigStore, assertPathAllowed } from "@desk/node";
import type { CommandResult } from "./install.ts";

/**
 * `desk cdp [--raw] [--ws]` (docs/IMPLEMENTATION.md §11): the guarded endpoint any CDP client should use, or with `--raw`
 * the Desk Chrome's own port; `--ws` asks the chosen endpoint for its browser WebSocket, so it needs Desk running.
 */
export async function cdpCommand(input: {
  deskHome: string;
  home: string;
  env: NodeJS.ProcessEnv;
  raw: boolean;
  ws: boolean;
}): Promise<CommandResult> {
  const config = await new FileConfigStore(input.deskHome).load();
  if (config === null) return { code: 69, message: "Desk has no config yet; run desk" };
  const warning = restoreKeyWarning({
    callerAgentConfig: input.env.AGENT_BROWSER_CONFIG,
    deskAgentConfig: join(input.deskHome, "agent-browser.json"),
    userConfigKeys: await userConfigKeys(input.home),
  });
  const warned = warning === null ? {} : { warning };
  const port = input.raw ? config.chrome.port : config.gateway.port;
  if (!input.ws) return { code: 0, message: cdpUrl(port), ...warned };
  const version = await new HttpDevTools().version(port);
  if (version === null) return { code: 69, message: "Desk is not running; run desk" };
  return { code: 0, message: version.wsUrl, ...warned };
}

/** The top-level keys of `~/.agent-browser/config.json`, never its values; `null` when there is none or it is not JSON. */
async function userConfigKeys(home: string): Promise<string[] | null> {
  const path = join(home, ".agent-browser", "config.json");
  await assertPathAllowed(path);
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? Object.keys(parsed) : null;
  } catch {
    return null;
  }
}
