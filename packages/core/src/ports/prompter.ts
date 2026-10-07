/** An answer from the operator, or a refusal to ask: consent needs an interactive terminal (SPEC §6.3). */
export type Consent = { ok: true; yes: boolean } | { ok: false; reason: "no-tty" };

/**
 * Asks the operator (docs/IMPLEMENTATION.md §3, §0 Consent). Adapter: packages/cli, which asks only when stdin and stdout
 * are a TTY. There is no `--yes`: tests inject `ScriptedPrompter`, and live tests answer through a PTY.
 */
export interface Prompter {
  confirm(question: string): Promise<Consent>;
}
