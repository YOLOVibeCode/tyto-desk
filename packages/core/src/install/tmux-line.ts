import { AGENT_VARIABLE_NAMES, TMUX_DESK_LINE } from "../pty/agent-env.ts";
import type { Prompter } from "../ports/prompter.ts";
import type { TextFiles } from "../ports/text-files.ts";
import type { Tmux } from "../ports/tmux.ts";

export type TmuxLinePorts = { files: TextFiles; tmux: Tmux | null; prompter: Prompter };

/**
 * Install's tmux step (docs/IMPLEMENTATION.md §11, §15.1): after you confirm, Desk's line is appended to `~/.tmux.conf`
 * once, and a running tmux server gets it too (`update-environment` is a server option; the file only reaches servers
 * started later). Nothing is asked when both already have it, or when tmux is not installed. `note` says what was not
 * done, for install's message.
 */
export async function addTmuxLine(ports: TmuxLinePorts, input: { home: string }): Promise<{ added: boolean; note: string | null }> {
  if (ports.tmux === null) return { added: false, note: null };
  const path = `${input.home.replace(/\/+$/, "")}/.tmux.conf`;
  const text = await ports.files.read(path);
  const inFile = text !== null && text.split("\n").some((line) => line.trim() === TMUX_DESK_LINE);
  const names = await ports.tmux.updateEnvironment();
  const serverNeeds = names !== null && !AGENT_VARIABLE_NAMES.every((name) => names.includes(name));
  if (inFile && !serverNeeds) return { added: false, note: null };
  const consent = await ports.prompter.confirm(
    `Add Desk's line to ~/.tmux.conf, so tmux sessions you create from a Desk pane can reach the Desk browser? (${TMUX_DESK_LINE})`,
  );
  if (!consent.ok) return { added: false, note: "the tmux line needs an interactive terminal: run desk install again from one" };
  if (!consent.yes) return { added: false, note: "you declined the tmux line: tmux sessions you create from a Desk pane will not reach the Desk browser" };
  if (!inFile) {
    const before = text === null || text === "" ? "" : text.endsWith("\n") ? text : `${text}\n`;
    await ports.files.write(path, `${before}# Desk: tmux sessions created from a Desk pane keep the Desk browser's variables.\n${TMUX_DESK_LINE}\n`, 0o644);
  }
  if (serverNeeds) await ports.tmux.appendUpdateEnvironment(AGENT_VARIABLE_NAMES);
  return { added: true, note: null };
}
