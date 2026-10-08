/**
 * A downloaded runtime tarball (§23.5). Adapter: packages/node (`tar -xzf` argv into an empty directory; a member with
 * an absolute path or `..` is refused). Returns the runtime directory it holds, or `null`.
 */
export interface Archive {
  extract(tarball: string, dir: string): Promise<string | null>;
}
