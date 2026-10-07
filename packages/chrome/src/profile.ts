import { mkdir, open, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { ChromeProfile, NativeHostDir } from "@desk/core";
import { assertPathAllowed, readIfExists, writePrivate } from "@desk/node";

function errorCode(err: unknown): string | undefined {
  return err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

/** The Desk profile's SingletonLock and its first-run seed (docs/IMPLEMENTATION.md §3, §5). */
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
