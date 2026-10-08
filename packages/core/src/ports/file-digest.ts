/** The sha256 of a file, as lowercase hex, or `null` when it cannot be read (§23.5). Adapter: packages/node. */
export interface FileDigest {
  sha256(path: string): Promise<string | null>;
}
