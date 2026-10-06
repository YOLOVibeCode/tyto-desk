import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readIfExists, writePrivate } from "../src/index.ts";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "files-"));
}

describe("private files", () => {
  it("writePrivate writes a 0600 file inside new 0700 directories", async () => {
    const root = await scratch();
    const path = join(root, "a", "b", "config.json");

    await writePrivate(path, '{"version":1}');

    expect(await readIfExists(path)).toBe('{"version":1}');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "a"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "a", "b"))).mode & 0o777).toBe(0o700);
  });

  it("writePrivate replaces a file whole and leaves no temporary file behind", async () => {
    const root = await scratch();
    const path = join(root, "layout.json");
    await writeFile(path, "old", { mode: 0o644 });

    await writePrivate(path, "new");

    expect(await readIfExists(path)).toBe("new");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(["layout.json"]);
  });

  it("readIfExists returns null for a missing file", async () => {
    expect(await readIfExists(join(await scratch(), "missing.json"))).toBeNull();
  });
});
