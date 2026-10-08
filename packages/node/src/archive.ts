import { mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Archive } from "@desk/core";
import { runArgv } from "./run.ts";
import { assertPathAllowed } from "./test-guard.ts";

/** Whether the file starts with gzip's magic bytes: bsdtar would otherwise read a zip, 7z, rar, iso or xar as well. */
async function isGzip(path: string): Promise<boolean> {
  const file = await open(path, "r").catch(() => null);
  if (file === null) return false;
  try {
    const head = Buffer.alloc(2);
    const { bytesRead } = await file.read(head, 0, 2, 0);
    return bytesRead === 2 && head[0] === 0x1f && head[1] === 0x8b;
  } finally {
    await file.close();
  }
}

/**
 * A runtime tarball (§23.5): it must be gzip; `tar -tzf` and `tar -tvzf` list its members first, and one with an
 * absolute path or a `..` segment, or one that is not a regular file or a directory (a link, a FIFO, a device), is
 * refused; then `tar -xzf` into an empty 0700 directory. The runtime is the one directory the tarball holds.
 */
export class TarArchive implements Archive {
  private readonly tar: string;

  constructor(tar = "/usr/bin/tar") {
    this.tar = tar;
  }

  async extract(tarball: string, dir: string): Promise<string | null> {
    await assertPathAllowed(dir);
    if (!(await isGzip(tarball))) return null;
    const env = { PATH: "/usr/bin:/bin", LC_ALL: "C" };
    const listed = await runArgv(this.tar, ["-tzf", tarball], { env, timeoutMs: 60_000, maxBytes: 16 * 1024 * 1024 });
    if (listed.code !== 0) return null;
    const members = listed.stdout.split("\n").filter((line) => line !== "");
    if (members.length === 0 || members.some((member) => member.startsWith("/") || member.split("/").includes(".."))) return null;
    const verbose = await runArgv(this.tar, ["-tvzf", tarball], { env, timeoutMs: 60_000, maxBytes: 32 * 1024 * 1024 });
    if (verbose.code !== 0 || verbose.stdout.split("\n").some((line) => line !== "" && line[0] !== "-" && line[0] !== "d")) return null;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if ((await readdir(dir)).length > 0) return null;
    const extracted = await runArgv(this.tar, ["-xzf", tarball, "-C", dir], { env, timeoutMs: 120_000 });
    if (extracted.code !== 0) return null;
    const top = await readdir(dir, { withFileTypes: true });
    return top.length === 1 && top[0]?.isDirectory() === true ? join(dir, top[0].name) : null;
  }
}
