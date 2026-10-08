import type { FileDigest } from "@desk/core";
import { fileSha256 } from "./app-versions.ts";
import { assertPathAllowed } from "./test-guard.ts";

/** A file's sha256, streamed (§23.5). */
export class NodeFileDigest implements FileDigest {
  async sha256(path: string): Promise<string | null> {
    await assertPathAllowed(path);
    return fileSha256(path).catch(() => null);
  }
}
