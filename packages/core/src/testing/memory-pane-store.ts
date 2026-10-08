import type { PaneStore, PanesFile } from "../ports/pane-store.ts";

const copy = (panes: PanesFile): PanesFile => JSON.parse(JSON.stringify(panes)) as PanesFile;

/** `panes.json` in memory: what `load` gives, and every save. */
export class MemoryPaneStore implements PaneStore {
  readonly saved: PanesFile[] = [];
  private loaded: { panes: PanesFile | null; recovered: boolean };

  constructor(loaded: { panes: PanesFile | null; recovered: boolean } = { panes: null, recovered: false }) {
    this.loaded = loaded;
  }

  async load(): Promise<{ panes: PanesFile | null; recovered: boolean }> {
    return this.loaded;
  }

  async save(panes: PanesFile): Promise<void> {
    this.saved.push(copy(panes));
    this.loaded = { panes: copy(panes), recovered: false };
  }

  /** The last panes saved, failing the test when nothing was. */
  last(): PanesFile {
    const panes = this.saved.at(-1);
    if (panes === undefined) throw new Error("the daemon saved no panes.json");
    return panes;
  }
}
