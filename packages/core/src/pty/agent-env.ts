import { cdpUrl, AGENT_BROWSER_CONFIG_FILE } from "../agents/agent-browser.ts";
import type { DeskConfig } from "../config/schema.ts";
import type { Env } from "../env/env.ts";
import { shellEnv } from "../env/shell-env.ts";
import type { TextFiles } from "../ports/text-files.ts";
import type { Tmux } from "../ports/tmux.ts";

/** The variables a Desk pane gives agents, in the order the tmux line lists them (§7.1, §11). */
export const AGENT_VARIABLE_NAMES: readonly string[] = ["AGENT_BROWSER_CONFIG", "AGENT_BROWSER_SESSION", "DESK_CDP_URL", "DESK_PANE"];

/**
 * Desk's line in the user's tmux config (§11): the server copies the four variables into a session from the client that
 * creates or attaches it, and removes them from sessions whose client lacks them (Termius, SSH).
 */
export const TMUX_DESK_LINE = `set -ga update-environment " ${AGENT_VARIABLE_NAMES.join(" ")}"`;

/** Where tmux reads the user's config, under the home. */
const TMUX_CONFIGS = [".tmux.conf", ".config/tmux/tmux.conf"];

export type AgentGate = { allowed: true } | { allowed: false; notice: "tmux-line-missing" };

function holdsDeskLine(text: string | null): boolean {
  return text !== null && text.split("\n").some((line) => line.trim() === TMUX_DESK_LINE);
}

/**
 * The agent-variable gate (§7.1), at every spawn. tmux is not installed (`tmux` is null): the variables are set. A tmux
 * server runs: only if its global `update-environment` lists all four. No server runs: only if `~/.tmux.conf` or
 * `~/.config/tmux/tmux.conf` holds Desk's exact line. Otherwise none of them, and the panel is told why: without the
 * line, a Desk pane that starts the tmux server puts the variables into every later session, Termius's included.
 */
export async function agentGate(input: { tmux: Tmux | null; files: TextFiles; home: string }): Promise<AgentGate> {
  if (input.tmux === null) return { allowed: true };
  const missing: AgentGate = { allowed: false, notice: "tmux-line-missing" };
  if (await input.tmux.serverRunning()) {
    const names = await input.tmux.updateEnvironment();
    if (names !== null) return AGENT_VARIABLE_NAMES.every((name) => names.includes(name)) ? { allowed: true } : missing;
  }
  const home = input.home.replace(/\/+$/, "");
  for (const config of TMUX_CONFIGS) {
    if (holdsDeskLine(await input.files.read(`${home}/${config}`))) return { allowed: true };
  }
  return missing;
}

export type PaneEnvironmentInput = {
  /** The daemon's own environment. */
  parent: Env;
  /** Desk's version, for `TERM_PROGRAM_VERSION`. */
  version: string;
  config: DeskConfig;
  deskHome: string;
  pane: string;
  gate: AgentGate;
};

/**
 * A pane's environment: core's allowlist (`shellEnv`) and, when the gate allows, the agent variables. Until slice 4a,
 * `DESK_CDP_URL` names the Desk Chrome's raw port, as `agent-browser.json` does.
 */
export function paneEnvironment(input: PaneEnvironmentInput): Record<string, string> {
  const agent = input.gate.allowed
    ? {
        config: `${input.deskHome}/${AGENT_BROWSER_CONFIG_FILE}`,
        session: `${input.config.agents.sessionPrefix}-${input.pane}`,
        cdpUrl: cdpUrl(input.config.chrome.port),
        pane: input.pane,
      }
    : null;
  return shellEnv({ parent: input.parent, version: input.version, agent });
}
