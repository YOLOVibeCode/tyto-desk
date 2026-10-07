/**
 * - `no-version-json`, `bad-files-list`: the runtime lacks one, or its files.sha256 is malformed.
 * - `mismatch`: a file differs from its listed sha256, is missing, or is not listed.
 */
export type StageResult =
  | { ok: true; staging: string; versionJson: string; build: string }
  | { ok: false; reason: "no-version-json" | "bad-files-list" | "mismatch" };

/**
 * The installed versions under `~/.desk/app` (docs/IMPLEMENTATION.md §3, §23.5): each complete and immutable once
 * installed, and `current`, a relative symlink replaced with one `rename(2)`. Adapter: packages/node.
 */
export interface AppVersions {
  list(): Promise<readonly string[]>;
  /** The version `current` names, or `null`. */
  current(): Promise<string | null>;
  /** An installed version's build id, the sha256 of its files.sha256; `null` when it has none (a damaged install). */
  build(version: string): Promise<string | null>;
  /**
   * Copies a runtime directory into a new `.staging-<id>` and checks every file against its files.sha256; `build` is the
   * list's own sha256. A staging that failed is already removed.
   */
  stage(from: string): Promise<StageResult>;
  /** Renames a verified staging directory into `app/<version>`. */
  commit(staging: string, version: string): Promise<void>;
  discard(staging: string): Promise<void>;
  /** Points `current` at an installed version with one rename. */
  use(version: string): Promise<void>;
}
