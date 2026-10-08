/** `missing`: no gh at Desk's fixed paths · `old`: older than 2.102.0, whose attestation checks Desk cannot rely on. */
export type GhInstalled = { ok: true } | { ok: false; reason: "missing" | "old" };

/**
 * Whether gh is installed and new enough for Desk's provenance checks, without going online (`desk doctor`,
 * docs/IMPLEMENTATION.md §15.2). Adapter: packages/cli (`gh --version`).
 */
export interface GhVersion {
  installed(): Promise<GhInstalled>;
}
