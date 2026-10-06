import type { Env } from "./env.ts";

/** Kept as they are when the parent has them. */
const KEPT = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "SSH_AUTH_SOCK", "__CF_USER_TEXT_ENCODING"] as const;

/** The login shell's `path_helper` and the user's dotfiles build the rest. */
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** tmux refuses to draw without a UTF-8 charset. */
const FALLBACK_LANG = "en_US.UTF-8";

/** `LANG` and the locale categories: POSIX's, plus glibc's for the Linux test container. No other `LC_*` name. */
const LOCALE_VARIABLES = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_ADDRESS",
  "LC_IDENTIFICATION",
  "LC_MEASUREMENT",
  "LC_NAME",
  "LC_PAPER",
  "LC_TELEPHONE",
] as const;

/**
 * A UTF-8 locale and nothing else: `UTF-8` alone (macOS's usual `LC_CTYPE`), or a locale name with a UTF-8 codeset,
 * such as `en_US.UTF-8`, `C.UTF-8`, `es_419.UTF-8` or `sr_RS.utf8@latin`.
 */
const UTF8_LOCALE = /^(?:utf-?8|[a-z]{1,8}(?:_[a-z0-9]{2,8}){0,2}\.utf-?8(?:@[a-z0-9]{1,16})?)$/i;

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

/**
 * The environment of a pane's login shell (docs/IMPLEMENTATION.md §7.1): an allowlist, never a blocklist. Everything
 * not named here is dropped, including API keys, `TMUX`, `ELECTRON_*`, `NODE_OPTIONS`, color overrides, every
 * `AGENT_BROWSER_*` variable the parent had, and any `LC_*` name that is not a locale category (`LC_TERMINAL`).
 * Locale categories pass only with a UTF-8 locale as their value.
 */
export function shellEnv(input: ShellEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of KEPT) {
    const value = input.parent[name];
    if (value !== undefined) env[name] = value;
  }
  for (const name of LOCALE_VARIABLES) {
    const value = input.parent[name];
    if (value !== undefined && UTF8_LOCALE.test(value)) env[name] = value;
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
