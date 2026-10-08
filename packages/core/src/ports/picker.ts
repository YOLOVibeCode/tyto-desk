/** The operator's choice, or a refusal to ask without an interactive terminal (SPEC §6.3). */
export type Picked = { ok: true; chosen: readonly number[] } | { ok: false; reason: "no-tty" };

/**
 * Lets the operator choose some of a list (docs/IMPLEMENTATION.md §14 step 5), with nothing chosen at first. Adapter:
 * packages/cli, on a TTY only.
 */
export interface Picker {
  pick(question: string, options: readonly string[]): Promise<Picked>;
}
