import type { Env } from "./env.ts";

/** Kept as they are when the parent has them. */
const KEPT = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "SSH_AUTH_SOCK", "__CF_USER_TEXT_ENCODING"] as const;

/** The login shell's `path_helper` and the user's dotfiles build the rest. */
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** tmux refuses to draw without a UTF-8 charset. */
const FALLBACK_LANG = "en_US.UTF-8";

const UTF8 = /utf-?8/i;

/** The variables that decide the charset. */
const CHARSET_VARIABLES = ["LC_ALL", "LC_CTYPE", "LANG"] as const;

/** What a Desk pane tells agent-browser and Desk-aware tools; passed only when the agent-variable gate allows. */
export type AgentVariables = {
  /** `AGENT_BROWSER_CONFIG`: Desk's agent-browser config file. */
  config: string;
  /** `AGENT_BROWSER_SESSION`: `desk-<pane>`. */
  session: string;
  /** `DESK_CDP_URL`: the guarded endpoint. */
  cdpUrl: string;
  /** `DESK_PANE`. */
  pane: string;
};

export type ShellEnvInput = {
  /** The daemon's own environment (Chrome's, which on macOS is launchd's GUI environment). */
  parent: Env;
  /** Desk's version, for `TERM_PROGRAM_VERSION`. */
  version: string;
  agent: AgentVariables | null;
};

function isLocaleVariable(name: string): boolean {
  return name === "LANG" || name.startsWith("LC_");
}

/**
 * The environment of a pane's login shell (docs/IMPLEMENTATION.md §7.1): an allowlist, never a blocklist. Everything
 * not named here is dropped, including API keys, `TMUX`, `ELECTRON_*`, `NODE_OPTIONS`, color overrides, and every
 * `AGENT_BROWSER_*` variable the parent had.
 */
export function shellEnv(input: ShellEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of KEPT) {
    const value = input.parent[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(input.parent)) {
    if (value !== undefined && isLocaleVariable(name) && UTF8.test(value)) env[name] = value;
  }
  if (!CHARSET_VARIABLES.some((name) => env[name] !== undefined)) env.LANG = FALLBACK_LANG;

  env.PATH = SYSTEM_PATH;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.CLICOLOR = "1";
  env.TERM_PROGRAM = "Desk";
  env.TERM_PROGRAM_VERSION = input.version;

  if (input.agent !== null) {
    env.AGENT_BROWSER_CONFIG = input.agent.config;
    env.AGENT_BROWSER_SESSION = input.agent.session;
    env.DESK_CDP_URL = input.agent.cdpUrl;
    env.DESK_PANE = input.agent.pane;
  }
  return env;
}
