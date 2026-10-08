import type { GhStatus, Provenance } from "../ports/provenance.ts";

/** A `gh` the test sets; attestations and asset checks pass unless refused, and every one is recorded. */
export class FakeProvenance implements Provenance {
  status: GhStatus = { ok: true };
  refuseAsset = false;
  refuseAttestation = false;
  readonly assets: { tag: string; file: string }[] = [];
  readonly attested: { file: string; workflow: string; ref: string; commit: string }[] = [];

  async gh(): Promise<GhStatus> {
    return this.status;
  }

  async verifyAsset(tag: string, file: string): Promise<boolean> {
    this.assets.push({ tag, file });
    return !this.refuseAsset;
  }

  async attest(file: string, input: { workflow: "release.yml" | "edge.yml"; ref: string; commit: string }): Promise<boolean> {
    this.attested.push({ file, ...input });
    return !this.refuseAttestation;
  }
}
