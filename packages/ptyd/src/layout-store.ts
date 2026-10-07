import { chmod, rename } from "node:fs/promises";
import { join } from "node:path";
import { parseStoredLayout, type Layout, type LayoutStore } from "@desk/core";
import { assertPathAllowed, readIfExists, writePrivate } from "@desk/node";

/** A UTC timestamp for a file moved aside: `20261007T221500Z`. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * `~/.desk/layout.json`, which only the daemon writes (docs/IMPLEMENTATION.md §4.1, §4.3): atomic 0600 writes; a file
 * that does not parse, has an unknown key, or a newer version is renamed `layout.json.corrupt-<UTC time>` (0600), and
 * nothing is loaded.
 */
export class NodeLayoutStore implements LayoutStore {
  private readonly path: string;

  constructor(deskHome: string) {
    this.path = join(deskHome, "layout.json");
  }

  async load(): Promise<{ layout: Layout | null; recovered: boolean }> {
    await assertPathAllowed(this.path);
    const text = await readIfExists(this.path);
    if (text === null) return { layout: null, recovered: false };
    const parsed = parseStoredLayout(text);
    if (parsed.recovered) {
      const aside = `${this.path}.corrupt-${stamp(new Date())}`;
      await rename(this.path, aside);
      await chmod(aside, 0o600);
    }
    return parsed;
  }

  async save(layout: Layout): Promise<void> {
    await writePrivate(this.path, `${JSON.stringify(layout)}\n`);
  }
}
