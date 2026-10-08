import { mkdir, open, readlink, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ChromeProfile, NativeHostDir } from "@desk/core";
import { assertPathAllowed, readIfExists, writePrivate } from "@desk/node";

function errorCode(err: unknown): string | undefined {
  return err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

/** The Desk profile's SingletonLock, its Local State, and its first-run seed (docs/IMPLEMENTATION.md §3, §5). */
export class NodeChromeProfile implements ChromeProfile {
  private readonly userDataDir: string;

  constructor(userDataDir: string) {
    this.userDataDir = userDataDir;
  }

  async singleton(): Promise<{ host: string; pid: number } | null> {
    const path = join(this.userDataDir, "SingletonLock");
    await assertPathAllowed(path);
    let target: string;
    try {
      target = await readlink(path);
    } catch (err) {
      if (["ENOENT", "EINVAL", "ENOTDIR"].includes(errorCode(err) ?? "")) return null;
      throw err;
    }
    const match = /^(.+)-(\d+)$/.exec(target);
    if (match === null || match[1] === undefined) return null;
    return { host: match[1], pid: Number(match[2]) };
  }

  async exitType(): Promise<string | null> {
    const file = join(this.userDataDir, "Default", "Preferences");
    await assertPathAllowed(file);
    const text = await readIfExists(file);
    if (text === null) return null;
    try {
      const value: unknown = JSON.parse(text);
      const profile = typeof value === "object" && value !== null ? (value as Record<string, unknown>).profile : undefined;
      const exit = typeof profile === "object" && profile !== null ? (profile as Record<string, unknown>).exit_type : undefined;
      return typeof exit === "string" ? exit : null;
    } catch {
      return null;
    }
  }

  async clearStaleSingleton(): Promise<void> {
    for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      const path = join(this.userDataDir, name);
      await assertPathAllowed(path);
      // A symlink each (Chrome's ProcessSingleton); rm removes the link, never what it points at.
      await rm(path, { force: true });
    }
  }

  async localStatePref(path: string): Promise<unknown> {
    const file = join(this.userDataDir, "Local State");
    await assertPathAllowed(file);
    const text = await readIfExists(file);
    if (text === null) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return undefined;
    }
    for (const key of path.split(".")) {
      if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return undefined;
      value = (value as Record<string, unknown>)[key];
    }
    return value;
  }

  async seedFirstRun(prefs: Readonly<Record<string, unknown>>): Promise<boolean> {
    const dir = join(this.userDataDir, "Default");
    const path = join(dir, "Preferences");
    await assertPathAllowed(path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let file;
    try {
      file = await open(path, "wx", 0o600);
    } catch (err) {
      if (errorCode(err) === "EEXIST") return false;
      throw err;
    }
    try {
      await file.writeFile(`${JSON.stringify(prefs)}\n`, "utf8");
    } finally {
      await file.close();
    }
    return true;
  }
}

/** The Desk profile's `NativeMessagingHosts` directory, which only the Desk Chrome reads (§8). */
export class NodeNativeHostDir implements NativeHostDir {
  private readonly dir: string;

  constructor(userDataDir: string) {
    this.dir = join(userDataDir, "NativeMessagingHosts");
  }

  private path(name: string): string {
    if (!/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(name)) throw new Error(`${JSON.stringify(name)} is not a native host name`);
    return join(this.dir, `${name}.json`);
  }

  async read(name: string): Promise<string | null> {
    return readIfExists(this.path(name));
  }

  async write(name: string, text: string): Promise<void> {
    await writePrivate(this.path(name), text);
  }
}
