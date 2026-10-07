import type { DeskConfig } from "../config/schema.ts";

/**
 * Keys `~/.desk/agent-browser.json` never has (docs/IMPLEMENTATION.md §11): each one restores, names or relocates a
 * session or a browser, so an agent in a Desk pane could load or save the user's own agent-browser state, or reach
 * another browser.
 */
export const FORBIDDEN_AGENT_BROWSER_KEYS: readonly string[] = [
  "restore",
  "sessionName",
  "state",
  "namespace",
  "profile",
  "executablePath",
  "autoConnect",
];

/** The file name of each under `~/.desk`. */
export const AGENT_BROWSER_CONFIG_FILE = "agent-browser.json";
export const AGENT_POLICY_FILE = "agent-policy.json";

/** The Desk Chrome's debugging port as an `http://` URL: agent-browser rediscovers the browser WebSocket on reconnect. */
export function cdpUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * `~/.desk/agent-browser.json`, rewritten at every launch (§11). `cdp` is the guarded endpoint (slice 4b), where the focus
 * guard keeps agents' tabs in the background. It saves nothing, pins each session to its tab, wraps page text in content
 * boundaries, disconnects idle sessions, and names Desk's action policy.
 */
export function agentBrowserConfig(input: { config: DeskConfig; deskHome: string }): Record<string, unknown> {
  return {
    cdp: cdpUrl(input.config.gateway.port),
    restoreSave: "never",
    pinTab: true,
    contentBoundaries: true,
    idleTimeout: input.config.agents.idleTimeout,
    actionPolicy: `${input.deskHome}/${AGENT_POLICY_FILE}`,
  };
}

/** What `~/.desk/agent-policy.json` holds: `open` by default (D21), `strict` on request, `paused` by `desk agents pause`. */
export type AgentPolicy = "open" | "strict" | "paused";

const STRICT_DENY = [
  "cookies_get",
  "cookies_set",
  "cookies_clear",
  "storage_get",
  "storage_set",
  "storage_clear",
  "state_save",
  "state_load",
  "credentials_get",
  "auth_show",
  "har_start",
];

/** agent-browser's action policy for a mode (§11). */
export function agentPolicy(mode: AgentPolicy): Record<string, unknown> {
  switch (mode) {
    case "open":
      return { default: "allow" };
    case "strict":
      return { default: "allow", deny: [...STRICT_DENY] };
    case "paused":
      return { default: "deny", allow: ["close"] };
    default: {
      const never: never = mode;
      throw new Error(`unknown agent policy ${String(never)}`);
    }
  }
}
