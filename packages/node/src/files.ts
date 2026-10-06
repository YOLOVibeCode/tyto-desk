import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { assertPathAllowed } from "./test-guard.ts";

function isMissing(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

/**
 * Writes `text` to `path` as a 0600 file, creating missing directories as 0700. The text goes to a new temp file
 * (exclusive create, so a planted file or link is never followed), is synced, and replaces `path` by rename, so
 * readers never see a partial file.
 */
export async function writePrivate(path: string, text: string): Promise<void> {
  await assertPathAllowed(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const file = await open(tmp, "wx", 0o600);
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** The file's text, or `null` when it does not exist. */
export async function readIfExists(path: string): Promise<string | null> {
  await assertPathAllowed(path);
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}
