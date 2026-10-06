import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/** What the ~/.desk check compares for one entry. Directories compare by kind and mode only: their own
 * timestamps change whenever an entry is added or removed, which is reported for that entry. */
type Stamp = string;

/** Kind, mode and (for files) size and timestamps of every entry under `root`, keyed by relative path. Never
 * reads file contents. An absent root has no entries. */
export type TreeSnapshot = { root: string; entries: Record<string, Stamp> };

function isMissing(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err.code === "ENOENT" || err.code === "ENOTDIR");
}

async function stampOf(path: string): Promise<Stamp | null> {
  try {
    const st = await lstat(path);
    const mode = (st.mode & 0o7777).toString(8);
    if (st.isDirectory()) return `dir ${mode}`;
    const kind = st.isSymbolicLink() ? "link" : st.isFile() ? "file" : "other";
    return `${kind} ${mode} ${st.size} ${st.mtimeMs} ${st.ctimeMs}`;
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/** Snapshots `root` without following symlinks. Top-level names in `skip` are left out with their subtrees. */
export async function snapshotTree(root: string, skip: readonly string[]): Promise<TreeSnapshot> {
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
      if (rel === "" && skip.includes(name)) continue;
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
