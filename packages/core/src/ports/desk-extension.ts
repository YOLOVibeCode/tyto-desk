/**
 * The Desk extension in the Desk Chrome, over CDP on the browser session (docs/IMPLEMENTATION.md §3, §6.1 step 9).
 * Adapter: packages/chrome (`Extensions.getExtensions`, `Extensions.loadUnpacked`).
 */
export interface DeskExtension {
  /** The manifest `version` of the extension Chrome has with this id, or `null` when it has none. */
  installedVersion(id: string): Promise<string | null>;
  /** Loads the unpacked extension at `path` and returns the id Chrome gave it; `refused` when Chrome would not. */
  load(path: string): Promise<{ ok: true; id: string } | { ok: false; reason: "refused" }>;
}
