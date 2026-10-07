/**
 * Small text files Desk reads and writes by absolute path (docs/IMPLEMENTATION.md §3). Adapter: packages/node, which
 * writes atomically (temp file and rename) and, under Vitest, refuses paths in the real home.
 */
export interface TextFiles {
  /** The file's text, or `null` when it does not exist. */
  read(path: string): Promise<string | null>;
  /** Replaces the file atomically with `mode` (0o600 for state, 0o700 for a launcher), creating 0700 directories. */
  write(path: string, text: string, mode: number): Promise<void>;
  /** Removes the file; a missing one is not an error. */
  remove(path: string): Promise<void>;
  /** The names of the regular files directly in `dir` (never their contents); none when it does not exist. */
  names(dir: string): Promise<readonly string[]>;
  /** `path` with symlinks resolved as far as it exists, the rest appended. */
  realPath(path: string): Promise<string>;
}
