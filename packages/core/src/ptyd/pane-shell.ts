import type { DeskConfig } from "../config/schema.ts";
import type { Env } from "../env/env.ts";
import type { LoginShell } from "../ports/login-shell.ts";
import type { TextFiles } from "../ports/text-files.ts";
import type { Tmux } from "../ports/tmux.ts";
import { agentGate, paneEnvironment } from "../pty/agent-env.ts";
import type { PaneShell } from "./daemon.ts";

/** The shell when neither the config nor the account names one. */
const FALLBACK_SHELL = "/bin/sh";

export type PaneShellInput = {
  pane: string;
  config: DeskConfig;
  deskHome: string;
  /** The account's home: the shell's directory, and where tmux's config is read. */
  home: string;
  /** The directory a split, a new tab or a restored pane starts in, which the caller found is a directory. */
  cwd?: string;
  /** A restored pane's tmux session: the pane runs `tmux attach-session -t =<name>` (§7.4). */
  attach?: string;
  /** The tmux binary an attach runs. */
  tmuxBinary?: string | null;
  /** The daemon's own environment. */
  parent: Env;
  version: string;
  /** The user's tmux, or `null` when tmux is not installed. */
  tmux: Tmux | null;
  files: TextFiles;
  loginShell: LoginShell;
};

/**
 * A new pane's shell (docs/IMPLEMENTATION.md §7.1): argv `[shell, "-l"]` with `shell = config.terminal.shell ??` the
 * account's passwd shell, in the directory it was given (a split's, §10) or the home directory (slice 7 restores saved
 * directories), with the pane environment. The
 * agent-variable gate runs at every spawn; when it withholds the variables, the panel gets the notice.
 */
export async function planPaneShell(input: PaneShellInput): Promise<PaneShell> {
  const shell = input.config.terminal.shell ?? (await input.loginShell.passwdShell()) ?? FALLBACK_SHELL;
  const gate = await agentGate({ tmux: input.tmux, files: input.files, home: input.home });
  const env = paneEnvironment({ parent: input.parent, version: input.version, config: input.config, deskHome: input.deskHome, pane: input.pane, gate });
  const cwd = input.cwd ?? input.home;
  const notice = gate.allowed ? null : gate.notice;
  // `=` asks tmux for exactly this session, never a prefix or a pattern.
  if (input.attach !== undefined && input.tmuxBinary !== undefined && input.tmuxBinary !== null) {
    return { file: input.tmuxBinary, args: ["attach-session", "-t", `=${input.attach}`], cwd, env, notice, loginShell: shell };
  }
  return { file: shell, args: ["-l"], cwd, env, notice, loginShell: shell };
}
