import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, inject, it } from "vitest";
import { makeRunRoots } from "./setup/run-roots.ts";
import { snapshotTree, treeChanges } from "./setup/tree-snapshot.ts";

describe("test isolation", () => {
  it("the test setup gives each run a fresh HOME, DESK_HOME and TMPDIR", async () => {
    const runRoot = inject("runRoot");
    const dirs = [process.env.HOME, process.env.DESK_HOME, process.env.TMPDIR];

    expect(basename(runRoot)).toMatch(/^desk-test-/);
    expect(new Set(dirs).size).toBe(3);
    for (const dir of dirs) {
      expect(dir?.startsWith(`${runRoot}/`)).toBe(true);
      expect(dir).not.toBe(inject("realHome"));
      expect((await stat(dir ?? "")).isDirectory()).toBe(true);
    }
    expect(homedir()).toBe(process.env.HOME);
    expect(tmpdir()).toBe(process.env.TMPDIR);
  });

  it("each run's roots are new, empty, and private to the user", async () => {
    const base = await mkdtemp(join(tmpdir(), "roots-"));
    const first = await makeRunRoots(base);
    const second = await makeRunRoots(base);

    expect(first.root).not.toBe(second.root);
    for (const dir of [first.home, first.deskHome, first.tmp]) {
      expect(await readdir(dir)).toEqual([]);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    }
    await rm(base, { recursive: true, force: true });
  });

  it("the real ~/.desk is unchanged after the suite", async () => {
    // The global teardown repeats this comparison after every test file has run and fails the run on any change;
    // test/real-desk-teardown.test.ts runs a suite that writes into a stand-in ~/.desk to prove it.
    const before = inject("realDeskBefore");

    expect(before.root).toBe(join(inject("realHome"), ".desk"));
    expect(treeChanges(before, await snapshotTree(before.root))).toEqual([]);
  });

  it("the ~/.desk check reports an added, a removed and a changed file", async () => {
    const root = await mkdtemp(join(tmpdir(), "desk-"));
    await writeFile(join(root, "config.json"), "{}");
    await writeFile(join(root, "panes.json"), "{}");
    const before = await snapshotTree(root);

    await writeFile(join(root, "layout.json"), "{}");
    await rm(join(root, "panes.json"));
    await utimes(join(root, "config.json"), new Date(1_000), new Date(1_000));

    expect(treeChanges(before, await snapshotTree(root))).toEqual(
      expect.arrayContaining(["changed config.json", "added layout.json", "removed panes.json"]),
    );
    await rm(root, { recursive: true, force: true });
  });

  it("the ~/.desk check reports a directory that appeared", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "home-")), ".desk");
    const absent = await snapshotTree(root);
    await mkdir(root);

    expect(treeChanges(absent, await snapshotTree(root))).toEqual(["added ."]);
  });

  it("the ~/.desk check reports a directory that disappeared", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "home-")), ".desk");
    await mkdir(root);
    const present = await snapshotTree(root);
    await rm(root, { recursive: true });

    expect(treeChanges(present, await snapshotTree(root))).toEqual(["removed ."]);
  });

  it("the ~/.desk check reports a file that was created and removed between its snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "desk-"));
    await mkdir(join(root, "run"));
    // An old timestamp, so the change shows even where the file system keeps whole seconds only.
    await utimes(join(root, "run"), new Date(1_000), new Date(1_000));
    const before = await snapshotTree(root);

    await writeFile(join(root, "run", "launch.lock"), "{}");
    await rm(join(root, "run", "launch.lock"));

    expect(treeChanges(before, await snapshotTree(root))).toEqual(["changed run"]);
    await rm(root, { recursive: true, force: true });
  });

  it("the ~/.desk check reports a change under logs/", async () => {
    const root = await mkdtemp(join(tmpdir(), "desk-"));
    await mkdir(join(root, "logs"));
    await writeFile(join(root, "logs", "ptyd.log"), "a");
    const before = await snapshotTree(root);

    await writeFile(join(root, "logs", "ptyd.log"), "ab");
    await writeFile(join(root, "logs", "ptyd.log.1"), "a");

    expect(treeChanges(before, await snapshotTree(root))).toEqual(
      expect.arrayContaining(["changed logs/ptyd.log", "added logs/ptyd.log.1"]),
    );
    await rm(root, { recursive: true, force: true });
  });
});
