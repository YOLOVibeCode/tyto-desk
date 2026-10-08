import type { GhInstalled, GhVersion } from "../ports/gh-version.ts";

/** A gh whose version the test sets. */
export class FakeGhVersion implements GhVersion {
  status: GhInstalled = { ok: true };

  async installed(): Promise<GhInstalled> {
    return this.status;
  }
}
