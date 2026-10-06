import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * What the ~/.desk check compares for one entry: kind, mode, and timestamps; for files and links also the size.
 * Directories carry their timestamps too, so a file that was created and removed again between two snapshots (a lock
 * taken and released) still shows, as a change to its directory.
 */
type Stamp = string;

/** The stamp of every entry under `root`, keyed by relative path. Never reads file contents. An absent root has no
 * entries. */
export type TreeSnapshot = { root: string; entries: Record<string, Stamp> };

function isMissing(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err.code === "ENOENT" || err.code === "ENOTDIR");
}

async function stampOf(path: string): Promise<Stamp | null> {
  try {
    const st = await lstat(path);
    const mode = (st.mode & 0o7777).toString(8);
    if (st.isDirectory()) return `dir ${mode} ${st.mtimeMs} ${st.ctimeMs}`;
    const kind = st.isSymbolicLink() ? "link" : st.isFile() ? "file" : "other";
    return `${kind} ${mode} ${st.size} ${st.mtimeMs} ${st.ctimeMs}`;
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/** Snapshots every entry under `root`, `logs/` included, without following symlinks. */
export async function snapshotTree(root: string): Promise<TreeSnapshot> {
  const entries: Record<string, Stamp> = {};
  const rootStamp = await stampOf(root);
  if (rootStamp === null) return { root, entries };
  entries["."] = rootStamp;
  if (!rootStamp.startsWith("dir ")) return { root, entries };

  const pending: string[] = [""];
  while (pending.length > 0) {
    const rel = pending.pop() ?? "";
    let names: string[];
    try {
      names = await readdir(join(root, rel));
    } catch (err) {
      if (isMissing(err)) continue;
      throw err;
    }
    for (const name of names) {
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const stamp = await stampOf(join(root, childRel));
      if (stamp === null) continue;
      entries[childRel] = stamp;
      if (stamp.startsWith("dir ")) pending.push(childRel);
    }
  }
  return { root, entries };
}

/** `added <path>`, `removed <path>` and `changed <path>` lines, sorted by path. Paths are names only. */
export function treeChanges(before: TreeSnapshot, after: TreeSnapshot): string[] {
  const paths = [...new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])].sort();
  const changes: string[] = [];
  for (const path of paths) {
    const was = before.entries[path];
    const now = after.entries[path];
    if (was === undefined) changes.push(`added ${path}`);
    else if (now === undefined) changes.push(`removed ${path}`);
    else if (was !== now) changes.push(`changed ${path}`);
  }
  return changes;
}
