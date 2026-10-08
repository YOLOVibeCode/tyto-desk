import type { TreeRemover } from "../ports/tree-remover.ts";
import type { MemoryTextFiles } from "./memory-text-files.ts";

/** Removes every file under a path from `files`, and records the path. */
export class FakeTreeRemover implements TreeRemover {
  readonly removed: string[] = [];
  private readonly files: MemoryTextFiles;

  constructor(files: MemoryTextFiles) {
    this.files = files;
  }

  async remove(path: string): Promise<void> {
    this.removed.push(path);
    const prefix = `${path.replace(/\/+$/, "")}/`;
    for (const name of [...this.files.files.keys()]) if (name === path || name.startsWith(prefix)) this.files.files.delete(name);
  }
}
