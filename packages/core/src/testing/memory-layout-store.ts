import type { Layout } from "../layout/layout.ts";
import type { LayoutStore } from "../ports/layout-store.ts";

/** A layout in memory: what `load` gives, and every layout saved. */
export class MemoryLayoutStore implements LayoutStore {
  readonly saved: Layout[] = [];
  private loaded: { layout: Layout | null; recovered: boolean };

  constructor(loaded: { layout: Layout | null; recovered: boolean } = { layout: null, recovered: false }) {
    this.loaded = loaded;
  }

  async load(): Promise<{ layout: Layout | null; recovered: boolean }> {
    return this.loaded;
  }

  async save(layout: Layout): Promise<void> {
    this.saved.push(layout);
    this.loaded = { layout, recovered: false };
  }
}
