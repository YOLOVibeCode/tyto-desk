import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Archive } from "@desk/core";
import { runArgv } from "./run.ts";
import { assertPathAllowed } from "./test-guard.ts";

/**
 * A runtime tarball (§23.5): `tar -tzf` lists its members first, and one with an absolute path or a `..` segment is
 * refused; then `tar -xzf` into an empty 0700 directory. The runtime is the one directory the tarball holds.
 */
export class TarArchive implements Archive {
  private readonly tar: string;

  constructor(tar = "/usr/bin/tar") {
    this.tar = tar;
  }

  async extract(tarball: string, dir: string): Promise<string | null> {
    await assertPathAllowed(dir);
    const env = { PATH: "/usr/bin:/bin", LC_ALL: "C" };
    const listed = await runArgv(this.tar, ["-tzf", tarball], { env, timeoutMs: 60_000, maxBytes: 16 * 1024 * 1024 });
    if (listed.code !== 0) return null;
    const members = listed.stdout.split("\n").filter((line) => line !== "");
    if (members.length === 0 || members.some((member) => member.startsWith("/") || member.split("/").includes(".."))) return null;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if ((await readdir(dir)).length > 0) return null;
    const extracted = await runArgv(this.tar, ["-xzf", tarball, "-C", dir], { env, timeoutMs: 120_000 });
    if (extracted.code !== 0) return null;
    const top = await readdir(dir, { withFileTypes: true });
    return top.length === 1 && top[0]?.isDirectory() === true ? join(dir, top[0].name) : null;
  }
}
