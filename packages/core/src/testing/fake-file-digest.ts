import type { FileDigest } from "../ports/file-digest.ts";

/** Digests by path, as the test sets them. */
export class FakeFileDigest implements FileDigest {
  readonly digests = new Map<string, string>();

  async sha256(path: string): Promise<string | null> {
    return this.digests.get(path) ?? null;
  }
}
