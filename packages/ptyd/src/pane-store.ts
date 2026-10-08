import { chmod, rename } from "node:fs/promises";
import { join } from "node:path";
import { parseStoredPanes, type PaneStore, type PanesFile } from "@desk/core";
import { assertPathAllowed, readIfExists, writePrivate } from "@desk/node";

/** A UTC timestamp for a file moved aside: `20261007T221500Z`. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * `~/.desk/panes.json`, which only the daemon writes (docs/IMPLEMENTATION.md §4.1, §7.4): atomic 0600 writes; a file
 * this build cannot read is renamed `panes.json.corrupt-<UTC time>` (0600), and nothing is loaded.
 */
export class NodePaneStore implements PaneStore {
  private readonly path: string;

  constructor(deskHome: string) {
    this.path = join(deskHome, "panes.json");
  }

  async load(): Promise<{ panes: PanesFile | null; recovered: boolean }> {
    await assertPathAllowed(this.path);
    const text = await readIfExists(this.path);
    if (text === null) return { panes: null, recovered: false };
    const parsed = parseStoredPanes(text);
    if (parsed.recovered) {
      const aside = `${this.path}.corrupt-${stamp(new Date())}`;
      await rename(this.path, aside);
      await chmod(aside, 0o600);
    }
    return parsed;
  }

  async save(panes: PanesFile): Promise<void> {
    await writePrivate(this.path, `${JSON.stringify(panes)}\n`);
  }
}
