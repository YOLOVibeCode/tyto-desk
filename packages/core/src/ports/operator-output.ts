/** Lines a consent operation prints as it goes (docs/IMPLEMENTATION.md §14): instructions and counts, never a secret. */
export interface OperatorOutput {
  say(line: string): void;
}
