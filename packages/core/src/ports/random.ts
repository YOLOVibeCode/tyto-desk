/** Randomness, injected so plans stay deterministic under test. Adapter: packages/node (`crypto.getRandomValues`). */
export interface Random {
  /** An integer from `min` to `max`, both included. */
  int(min: number, max: number): number;
  /** `<prefix>_` and 10 lowercase Crockford base32 characters, such as `p_k2m9q3x7ab`. */
  id(prefix: string): string;
}
