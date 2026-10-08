/** What a path is, its permission bits, and whether the current user owns it; `null` when it does not exist. */
export type PathMode = { kind: "file" | "dir" | "link" | "other"; mode: number; mine: boolean };

/** `lstat` facts for `desk doctor`'s ownership and mode checks (docs/IMPLEMENTATION.md §15.2). Adapter: packages/node. */
export interface PathModes {
  stat(path: string): Promise<PathMode | null>;
}
