import type { Env } from "./env.ts";

/**
 * What the daemon keeps of the environment it is started with (Chrome's, which on macOS is launchd's GUI environment,
 * passed on by the native host): who and where the user is, the locale, the SSH agent, where tmux keeps its sockets, and
 * Desk's own home. `shellEnv` then builds each pane's environment from it. An allowlist: nothing else, so no API key,
 * `NODE_OPTIONS` or `TMUX` reaches the daemon or its shells.
 */
const KEPT = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "PATH",
  "SSH_AUTH_SOCK",
  "__CF_USER_TEXT_ENCODING",
  "TMUX_TMPDIR",
  "DESK_HOME",
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
];

export function daemonEnvironment(parent: Env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of KEPT) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
