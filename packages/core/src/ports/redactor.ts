/** Removes secrets from a string before it reaches disk or a model (docs/IMPLEMENTATION.md §0, §3). Core: `SecretRedactor`. */
export interface Redactor {
  safe(text: string): string;
}
