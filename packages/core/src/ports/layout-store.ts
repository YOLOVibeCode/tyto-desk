import type { Layout } from "../layout/layout.ts";

/**
 * `layout.json`, which only the daemon writes (docs/IMPLEMENTATION.md §3, §4.1, §4.3). `load` gives `null` when there
 * is none; a file that does not parse, has unknown keys, or a newer version is moved aside (`recovered`). Adapter:
 * packages/ptyd (atomic 0600 writes).
 */
export interface LayoutStore {
  load(): Promise<{ layout: Layout | null; recovered: boolean }>;
  save(layout: Layout): Promise<void>;
}
