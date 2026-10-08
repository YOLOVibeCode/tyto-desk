/**
 * - `missing`: no `gh` on PATH. `old`: older than 2.102.0, which matched `--signer-workflow` as a prefix and `--source-ref`
 *   without case (GHSA-wjmr-j3rp-mh2g, GHSA-4mq3-hpgx-9cx8). `signed-out`: `gh auth status` fails.
 */
export type GhStatus = { ok: true } | { ok: false; reason: "missing" | "old" | "signed-out" };

/**
 * Where a download came from (docs/IMPLEMENTATION.md §23.5). Adapter: packages/cli (`gh` argv). Provenance is required:
 * nothing skips it (D40).
 */
export interface Provenance {
  gh(): Promise<GhStatus>;
  /** `gh release verify-asset <tag> <file>`: the file is the release's own asset. */
  verifyAsset(tag: string, file: string): Promise<boolean>;
  /**
   * `gh attestation verify <file> --cert-identity <the workflow on the ref, exactly> --source-ref <ref> --source-digest
   * <commit> --deny-self-hosted-runners`.
   */
  attest(file: string, input: { workflow: "release.yml" | "edge.yml"; ref: string; commit: string }): Promise<boolean>;
}
