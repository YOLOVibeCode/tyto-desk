import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeTextFiles, TestIsolationError } from "../src/index.ts";

const files = new NodeTextFiles();
const realHome = process.env.DESK_TEST_REAL_HOME ?? userInfo().homedir;
/** Writes aim here, never at ~/.desk: if the guard ever failed, the damage would be one stray directory. */
const realHomeProbe = join(realHome, ".desk-test-guard-probe", "probe.json");
const scratch = () => mkdtemp(join(tmpdir(), "text-files-"));

describe("NodeTextFiles", () => {
  it("write replaces a file atomically with the given mode inside new 0700 directories", async () => {
    const root = await scratch();
    const path = join(root, "bin", "desk");

    await files.write(path, "#!/bin/sh\n", 0o700);

    expect(await readFile(path, "utf8")).toBe("#!/bin/sh\n");
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "bin"))).mode & 0o777).toBe(0o700);
  });

  it("read returns the text, or null for a missing file", async () => {
    const root = await scratch();
    await writeFile(join(root, "a.json"), "{}");

    expect(await files.read(join(root, "a.json"))).toBe("{}");
    expect(await files.read(join(root, "missing.json"))).toBeNull();
  });

  it("names lists a directory's regular files only, and nothing for a missing directory", async () => {
    const root = await scratch();
    await writeFile(join(root, "b.js"), "");
    await writeFile(join(root, "a.html"), "");
    await mkdir(join(root, "dir"));
    await symlink(join(root, "a.html"), join(root, "link.html"));

    expect(await files.names(root)).toEqual(["a.html", "b.js"]);
    expect(await files.names(join(root, "missing"))).toEqual([]);
  });

  it("remove deletes a file, and a missing one is not an error", async () => {
    const root = await scratch();
    await writeFile(join(root, "old.js"), "");

    await files.remove(join(root, "old.js"));
    await files.remove(join(root, "old.js"));

    expect(await files.read(join(root, "old.js"))).toBeNull();
  });

  it("realPath resolves symlinks as far as the path exists", async () => {
    const root = await scratch();
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "link"));

    expect(await files.realPath(join(root, "link", "not", "yet"))).toBe(join(await files.realPath(root), "real", "not", "yet"));
  });

  it("text files refuse the real home under Vitest", async () => {
    await expect(files.write(realHomeProbe, "{}", 0o600)).rejects.toBeInstanceOf(TestIsolationError);
    await expect(files.read(realHomeProbe)).rejects.toBeInstanceOf(TestIsolationError);
    await expect(files.names(join(realHome, ".desk-test-guard-probe"))).rejects.toBeInstanceOf(TestIsolationError);
  });
});
