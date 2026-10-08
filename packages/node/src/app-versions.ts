import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, rename, rm, stat, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { FILES_SHA256, parseFilesSha256, parseSemver, type AppVersions, type StageResult } from "@desk/core";
import { assertPathAllowed } from "./test-guard.ts";

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

function isMissing(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err.code === "ENOENT" || err.code === "ENOTDIR");
}

function randomId(): string {
  return [...randomBytes(10)].map((byte) => CROCKFORD[byte & 31] ?? "0").join("");
}

/** A version name is a SemVer version, which is also a safe directory name. */
function isVersionName(name: string): boolean {
  return parseSemver(name) !== null;
}

/** The sha256 of a file, streamed. */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
  return hash.digest("hex");
}

/**
 * Copies a runtime `from` into `to` as plain files and directories, keeping only the execute bits of each file's mode;
 * anything else (a symbolic link, a device) makes the copy fail (null). Returns the copied files' paths, `/`-separated.
 */
/**
 * Copies a runtime into `to`. A file `reuse` names (one identical to the current version's) is cloned from there; every
 * file is copied with COPYFILE_FICLONE, so on APFS installed versions share their identical files (§23.5 rule 7).
 */
export async function copyRuntime(from: string, to: string, reuse: ReadonlyMap<string, string> = new Map()): Promise<string[] | null> {
  return copyTree(from, to, "", reuse);
}

async function copyTree(from: string, to: string, rel: string, reuse: ReadonlyMap<string, string>): Promise<string[] | null> {
  const copied: string[] = [];
  for (const entry of await readdir(join(from, rel), { withFileTypes: true })) {
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      await mkdir(join(to, path), { mode: 0o700 });
      const inner = await copyTree(from, to, path, reuse);
      if (inner === null) return null;
      copied.push(...inner);
    } else if (entry.isFile()) {
      const same = reuse.get(path);
      const cloned = same !== undefined && (await copyFile(same, join(to, path), constants.COPYFILE_FICLONE).then(() => true, () => false));
      if (!cloned) await copyFile(join(from, path), join(to, path), constants.COPYFILE_FICLONE);
      const mode = (await stat(join(from, path))).mode & 0o111 ? 0o755 : 0o644;
      await chmod(join(to, path), mode);
      copied.push(path);
    } else {
      return null;
    }
  }
  return copied;
}

/** The regular files under `dir`, relative and `/`-separated; `null` when it holds anything else (a link, a socket). */
async function listTree(dir: string, rel: string): Promise<string[] | null> {
  const found: string[] = [];
  for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      const inner = await listTree(dir, path);
      if (inner === null) return null;
      found.push(...inner);
    } else if (entry.isFile()) {
      found.push(path);
    } else {
      return null;
    }
  }
  return found;
}

/** Makes every directory under `dir` writable by its owner, so the tree can be removed. */
async function chmodTree(dir: string): Promise<void> {
  await chmod(dir, 0o700);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await chmodTree(join(dir, entry.name));
  }
}

/**
 * `~/.desk/app` (docs/IMPLEMENTATION.md §23.5): versions side by side, each complete once installed, and `current`, a
 * relative symlink that changes only by renaming a new link over it. A runtime is copied into `.staging-<id>` and
 * checked file by file against its files.sha256 there, so what is verified is what gets installed.
 */
export class NodeAppVersions implements AppVersions {
  private readonly appDir: string;
  private readonly copy: (from: string, to: string, reuse: ReadonlyMap<string, string>) => Promise<string[] | null>;

  /** `copy` copies a runtime into a staging directory (`copyRuntime`); a test gives one that also changes the source. */
  constructor(deskHome: string, options: { copy?: (from: string, to: string) => Promise<string[] | null> } = {}) {
    this.appDir = join(deskHome, "app");
    this.copy = options.copy ?? copyRuntime;
  }

  async list(): Promise<readonly string[]> {
    await assertPathAllowed(this.appDir);
    try {
      return (await readdir(this.appDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && isVersionName(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
  }

  async current(): Promise<string | null> {
    await assertPathAllowed(this.appDir);
    try {
      const target = await readlink(join(this.appDir, "current"));
      return isVersionName(target) ? target : null;
    } catch (err) {
      if (isMissing(err) || (err instanceof Error && "code" in err && err.code === "EINVAL")) return null;
      throw err;
    }
  }

  async build(version: string): Promise<string | null> {
    const list = join(this.versionDir(version), FILES_SHA256);
    await assertPathAllowed(list);
    try {
      return createHash("sha256").update(await readFile(list, "utf8")).digest("hex");
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async stage(from: string): Promise<StageResult> {
    await assertPathAllowed(this.appDir);
    await assertPathAllowed(from);
    let listText: string;
    let versionJson: string;
    try {
      listText = await readFile(join(from, FILES_SHA256), "utf8");
    } catch (err) {
      if (isMissing(err)) return { ok: false, reason: "bad-files-list" };
      throw err;
    }
    try {
      versionJson = await readFile(join(from, "version.json"), "utf8");
    } catch (err) {
      if (isMissing(err)) return { ok: false, reason: "no-version-json" };
      throw err;
    }
    const listed = parseFilesSha256(listText);
    if (listed === null) return { ok: false, reason: "bad-files-list" };
    await mkdir(this.appDir, { recursive: true, mode: 0o700 });
    const staging = join(this.appDir, `.staging-${randomId()}`);
    await mkdir(staging, { mode: 0o700 });
    try {
      const copied = await this.copy(from, staging, await this.identicalToCurrent(listed));
      const files = copied?.filter((path) => path !== FILES_SHA256) ?? null;
      if (files === null || files.length !== listed.size) throw new MismatchError();
      for (const path of files) {
        const digest = listed.get(path);
        if (digest === undefined || digest !== (await fileSha256(join(staging, ...path.split("/"))))) throw new MismatchError();
      }
      // The copy's own list and version.json must be the ones read and checked: a source changed meanwhile is refused.
      if ((await readFile(join(staging, FILES_SHA256), "utf8").catch(() => null)) !== listText) throw new MismatchError();
      if ((await readFile(join(staging, "version.json"), "utf8")) !== versionJson) throw new MismatchError();
    } catch (err) {
      await rm(staging, { recursive: true, force: true });
      if (err instanceof MismatchError) return { ok: false, reason: "mismatch" };
      throw err;
    }
    return { ok: true, staging, versionJson, build: createHash("sha256").update(listText).digest("hex") };
  }

  async verify(version: string): Promise<boolean> {
    if (!isVersionName(version)) return false;
    const dir = join(this.appDir, version);
    await assertPathAllowed(dir);
    const listText = await readFile(join(dir, FILES_SHA256), "utf8").catch(() => null);
    const listed = listText === null ? null : parseFilesSha256(listText);
    if (listed === null) return false;
    const present = await listTree(dir, "");
    if (present === null) return false;
    const files = present.filter((path) => path !== FILES_SHA256);
    if (files.length !== listed.size) return false;
    for (const path of files) {
      if (listed.get(path) !== (await fileSha256(join(dir, ...path.split("/"))))) return false;
    }
    return true;
  }

  async commit(staging: string, version: string): Promise<void> {
    this.assertStaging(staging);
    const target = this.versionDir(version);
    await assertPathAllowed(target);
    const exists = await lstat(target).then(
      () => true,
      (err: unknown) => {
        if (isMissing(err)) return false;
        throw err;
      },
    );
    if (exists) throw new Error(`${version} is already installed`);
    await rename(staging, target);
  }

  async discard(staging: string): Promise<void> {
    this.assertStaging(staging);
    await assertPathAllowed(staging);
    await rm(staging, { recursive: true, force: true });
  }

  /** Each listed file the current version holds with the same sha256, as the path to clone it from. */
  private async identicalToCurrent(listed: ReadonlyMap<string, string>): Promise<Map<string, string>> {
    const reuse = new Map<string, string>();
    const current = await this.current();
    if (current === null) return reuse;
    const dir = this.versionDir(current);
    const theirs = parseFilesSha256((await readFile(join(dir, FILES_SHA256), "utf8").catch(() => "")) ?? "");
    if (theirs === null) return reuse;
    for (const [path, digest] of listed) if (theirs.get(path) === digest) reuse.set(path, join(dir, ...path.split("/")));
    return reuse;
  }

  async remove(version: string): Promise<void> {
    if (!isVersionName(version)) throw new RangeError(`not a version: ${version}`);
    if ((await this.current()) === version) throw new Error(`${version} is current`);
    const dir = this.versionDir(version);
    await assertPathAllowed(dir);
    // Installed versions are read-only (0500 directories); they become writable only to be removed.
    await chmodTree(dir).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }

  async use(version: string): Promise<void> {
    const target = this.versionDir(version);
    await assertPathAllowed(target);
    const installed = await stat(target).then(
      (st) => st.isDirectory(),
      () => false,
    );
    if (!installed) throw new Error(`${version} is not installed`);
    const link = join(this.appDir, `.current-${randomId()}`);
    await symlink(version, link);
    try {
      await rename(link, join(this.appDir, "current"));
    } catch (err) {
      await rm(link, { force: true });
      throw err;
    }
  }

  private versionDir(version: string): string {
    if (!isVersionName(version)) throw new Error(`${JSON.stringify(version)} is not a version`);
    return join(this.appDir, version);
  }

  private assertStaging(staging: string): void {
    if (dirname(staging) !== this.appDir || !basename(staging).startsWith(".staging-")) {
      throw new Error(`${staging} is not a staging directory of ${this.appDir}`);
    }
  }
}

class MismatchError extends Error {}
