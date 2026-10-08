import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatFilesSha256 } from "../../core/src/index.ts";
import { NodeAppVersions, copyRuntime } from "../src/index.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** A runtime as npm run pack leaves it: version.json, a nested executable, and files.sha256 over all of them. */
async function runtime(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "runtime-"));
  const all: Record<string, string> = {
    "version.json": JSON.stringify({ version: "0.3.1-dev.x+a1b2c3d" }),
    "desk.mjs": "export {};\n",
    "node/desk-node": "#!/bin/sh\n",
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  await chmod(join(dir, "node/desk-node"), 0o755);
  await writeFile(join(dir, "files.sha256"), formatFilesSha256(new Map(Object.entries(all).map(([path, text]) => [path, sha(text)]))));
  return dir;
}

async function deskHome(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "desk-home-")), ".desk");
}

describe("NodeAppVersions", () => {
  it("stage copies a runtime into a 0700 staging directory under app/ and checks it against files.sha256", async () => {
    const versions = new NodeAppVersions(await deskHome());
    const from = await runtime();

    const staged = await versions.stage(from);
    if (!staged.ok) throw new Error(`stage failed: ${staged.reason}`);

    expect(staged.staging).toMatch(/\/app\/\.staging-[0-9a-z]{10}$/);
    expect((await stat(staged.staging)).mode & 0o777).toBe(0o700);
    expect(staged.versionJson).toBe(JSON.stringify({ version: "0.3.1-dev.x+a1b2c3d" }));
    expect(staged.build).toBe(sha(await readFile(join(from, "files.sha256"), "utf8")));
    expect((await stat(join(staged.staging, "node/desk-node"))).mode & 0o111).not.toBe(0);
  });

  it.each([
    ["a changed file", async (dir: string) => writeFile(join(dir, "desk.mjs"), "export const x = 1;\n")],
    ["a file files.sha256 does not list", async (dir: string) => writeFile(join(dir, "extra.mjs"), "")],
    ["a listed file that is missing", async (dir: string) => (await import("node:fs/promises")).rm(join(dir, "desk.mjs"))],
    ["a symbolic link", async (dir: string) => symlink("/etc/hosts", join(dir, "hosts"))],
  ])("stage refuses a runtime with %s and leaves no staging behind", async (_label, change) => {
    const home = await deskHome();
    const versions = new NodeAppVersions(home);
    const from = await runtime();
    await change(from);

    expect(await versions.stage(from)).toEqual({ ok: false, reason: "mismatch" });
    expect((await readdir(join(home, "app"))).filter((name) => name.startsWith(".staging-"))).toEqual([]);
  });

  it("stage refuses a runtime without files.sha256 or version.json", async () => {
    const versions = new NodeAppVersions(await deskHome());
    const empty = await mkdtemp(join(tmpdir(), "runtime-"));

    expect(await versions.stage(empty)).toMatchObject({ ok: false });
  });

  it.each([
    ["a link", (path: string) => symlink("/dev/zero", path)],
    ["a FIFO", async (path: string) => void execFileSync("mkfifo", [path])],
  ])("stage refuses a runtime whose version.json is %s, without reading it", async (_, make) => {
    const versions = new NodeAppVersions(await deskHome());
    const dir = await runtime();
    await rm(join(dir, "version.json"));
    await make(join(dir, "version.json"));

    expect(await versions.stage(dir)).toEqual({ ok: false, reason: "no-version-json" });
  });

  it("commit renames a staging into app/<version>, and current switches with a relative link", async () => {
    const home = await deskHome();
    const versions = new NodeAppVersions(home);
    const staged = await versions.stage(await runtime());
    if (!staged.ok) throw new Error("stage failed");

    await versions.commit(staged.staging, "0.3.1-dev.x+a1b2c3d");
    await versions.use("0.3.1-dev.x+a1b2c3d");

    expect(await versions.list()).toEqual(["0.3.1-dev.x+a1b2c3d"]);
    expect(await versions.current()).toBe("0.3.1-dev.x+a1b2c3d");
    expect(await readlink(join(home, "app", "current"))).toBe("0.3.1-dev.x+a1b2c3d");
    expect((await lstat(join(home, "app", "current"))).isSymbolicLink()).toBe(true);
    expect(await readdir(join(home, "app"))).toEqual(["0.3.1-dev.x+a1b2c3d", "current"]);
  });

  it("use switches current from one version to another and leaves the first in place", async () => {
    const home = await deskHome();
    const versions = new NodeAppVersions(home);
    for (const name of ["0.3.0", "0.3.1"]) {
      const staged = await versions.stage(await runtime({ "version.json": JSON.stringify({ version: name }) }));
      if (!staged.ok) throw new Error("stage failed");
      await versions.commit(staged.staging, name);
    }

    await versions.use("0.3.0");
    await versions.use("0.3.1");

    expect(await versions.current()).toBe("0.3.1");
    expect(await versions.list()).toEqual(["0.3.0", "0.3.1"]);
  });

  it("commit refuses to replace a version that is installed", async () => {
    const home = await deskHome();
    const versions = new NodeAppVersions(home);
    const first = await versions.stage(await runtime());
    const second = await versions.stage(await runtime());
    if (!first.ok || !second.ok) throw new Error("stage failed");
    await versions.commit(first.staging, "0.3.0");

    await expect(versions.commit(second.staging, "0.3.0")).rejects.toThrow();
  });

  it("use refuses a version that is not installed, and a name that is not a version", async () => {
    const versions = new NodeAppVersions(await deskHome());

    await expect(versions.use("0.9.9")).rejects.toThrow(/not installed/);
    await expect(versions.use("../../etc")).rejects.toThrow(/not a version/);
  });

  it("discard removes a staging directory", async () => {
    const home = await deskHome();
    const versions = new NodeAppVersions(home);
    const staged = await versions.stage(await runtime());
    if (!staged.ok) throw new Error("stage failed");

    await versions.discard(staged.staging);

    expect(await readdir(join(home, "app"))).toEqual([]);
  });

  it("current is null before any install", async () => {
    expect(await new NodeAppVersions(await deskHome()).current()).toBeNull();
  });

  it("an installed version's build is the sha256 of its files.sha256, and one without that file has none", async () => {
    const home = await deskHome();
    const versions = new NodeAppVersions(home);
    const from = await runtime();
    const staged = await versions.stage(from);
    if (!staged.ok) throw new Error("stage failed");
    await versions.commit(staged.staging, "0.3.0");
    await mkdir(join(home, "app", "0.2.0"), { mode: 0o700 });

    expect(await versions.build("0.3.0")).toBe(sha(await readFile(join(from, "files.sha256"), "utf8")));
    expect(await versions.build("0.2.0")).toBeNull();
    expect(await versions.build("0.9.9")).toBeNull();
  });

  it("stage refuses a runtime whose files.sha256 changes while it is copied, so the list installed is the list verified", async () => {
    const home = await deskHome();
    const from = await runtime();
    const listed = await readFile(join(from, "files.sha256"), "utf8");
    // Another writer rewrites the list between stage's read and its copy: the same entries, other text.
    const versions = new NodeAppVersions(home, {
      copy: async (source, staging) => {
        const copied = await copyRuntime(source, staging);
        await writeFile(join(staging, "files.sha256"), `${listed}\n`);
        return copied;
      },
    });

    expect(await versions.stage(from)).toEqual({ ok: false, reason: "mismatch" });
    expect((await readdir(join(home, "app"))).filter((name) => name.startsWith(".staging-"))).toEqual([]);
  });

  it("a staged runtime is a copy: changing the source afterwards changes nothing installed", async () => {
    const home = await deskHome();
    const versions = new NodeAppVersions(home);
    const from = await runtime();
    const staged = await versions.stage(from);
    if (!staged.ok) throw new Error("stage failed");
    await cp(join(from, "version.json"), join(from, "copy.json"));
    await writeFile(join(from, "desk.mjs"), "changed\n");

    expect(await readFile(join(staged.staging, "desk.mjs"), "utf8")).toBe("export {};\n");
  });

  it("verify passes an installed version whose files match its files.sha256", async () => {
    const versions = new NodeAppVersions(await deskHome());
    const staged = await versions.stage(await runtime());
    if (!staged.ok) throw new Error("stage failed");
    await versions.commit(staged.staging, "0.3.1-dev.x+a1b2c3d");

    expect(await versions.verify("0.3.1-dev.x+a1b2c3d")).toBe(true);
  });

  it.each([
    ["a changed file", (dir: string) => writeFile(join(dir, "desk.mjs"), "export const x = 1;\n")],
    ["an added file", (dir: string) => writeFile(join(dir, "extra.mjs"), "")],
    ["a missing file", async (dir: string) => (await import("node:fs/promises")).rm(join(dir, "desk.mjs"))],
    ["a symbolic link", (dir: string) => symlink("/etc/hosts", join(dir, "hosts"))],
  ])("verify refuses an installed version with %s", async (_label, change) => {
    const home = await deskHome();
    const versions = new NodeAppVersions(home);
    const staged = await versions.stage(await runtime());
    if (!staged.ok) throw new Error("stage failed");
    await versions.commit(staged.staging, "0.3.1-dev.x+a1b2c3d");
    const dir = join(home, "app", "0.3.1-dev.x+a1b2c3d");
    await chmod(dir, 0o700);
    await chmod(join(dir, "desk.mjs"), 0o644).catch(() => undefined);

    await change(dir);

    expect(await versions.verify("0.3.1-dev.x+a1b2c3d")).toBe(false);
  });

  it("install clones files identical to the current version's instead of copying them", async () => {
    const versions = new NodeAppVersions(await deskHome());
    const first = await versions.stage(await runtime());
    if (!first.ok) throw new Error("stage failed");
    await versions.commit(first.staging, "0.3.1-dev.x+a1b2c3d");
    await versions.use("0.3.1-dev.x+a1b2c3d");
    // The next version's desk.mjs is the current one's; only a clone from the current version can read it.
    const next = await runtime({ "version.json": JSON.stringify({ version: "0.3.2-dev.x+a1b2c3d" }) });
    await chmod(join(next, "desk.mjs"), 0o000);

    const staged = await versions.stage(next);

    expect(staged.ok).toBe(true);
  });

  it("remove deletes an installed version that is not current, and refuses the current one", async () => {
    const home = await deskHome();
    const versions = new NodeAppVersions(home);
    for (const version of ["0.3.1-dev.x+a1b2c3d", "0.3.2-dev.x+a1b2c3d"]) {
      const staged = await versions.stage(await runtime());
      if (!staged.ok) throw new Error("stage failed");
      await versions.commit(staged.staging, version);
    }
    await versions.use("0.3.2-dev.x+a1b2c3d");

    await versions.remove("0.3.1-dev.x+a1b2c3d");

    expect(await versions.list()).toEqual(["0.3.2-dev.x+a1b2c3d"]);
    await expect(versions.remove("0.3.2-dev.x+a1b2c3d")).rejects.toThrow(/current/);
  });
});
