import { readdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { TextFiles } from "@desk/core";
import { writeAtomic } from "./files.ts";
import { assertPathAllowed } from "./test-guard.ts";

function isMissing(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err.code === "ENOENT" || err.code === "ENOTDIR");
}

/** Text files by absolute path (docs/IMPLEMENTATION.md §3), behind the test guard, written atomically. */
export class NodeTextFiles implements TextFiles {
  async read(path: string): Promise<string | null> {
    await assertPathAllowed(path);
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async write(path: string, text: string, mode: number): Promise<void> {
    await writeAtomic(path, text, mode);
  }

  async remove(path: string): Promise<void> {
    await assertPathAllowed(path);
    await rm(path, { force: true });
  }

  async names(dir: string): Promise<readonly string[]> {
    await assertPathAllowed(dir);
    try {
      return (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
  }

  async realPath(path: string): Promise<string> {
    await assertPathAllowed(path);
    const rest: string[] = [];
    for (let current = path; ; current = dirname(current)) {
      try {
        return join(await realpath(current), ...rest);
      } catch (err) {
        if (!isMissing(err) || dirname(current) === current) throw err;
        rest.unshift(basename(current));
      }
    }
  }
}
