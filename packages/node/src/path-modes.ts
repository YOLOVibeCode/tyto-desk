import { lstat } from "node:fs/promises";
import type { PathMode, PathModes } from "@desk/core";
import { assertPathAllowed } from "./test-guard.ts";

/** `lstat` for `desk doctor` (§15.2): never follows a link, so a symlinked `~/.desk` reads as a link. */
export class NodePathModes implements PathModes {
  async stat(path: string): Promise<PathMode | null> {
    await assertPathAllowed(path);
    const st = await lstat(path).catch(() => null);
    if (st === null) return null;
    const kind = st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
    return { kind, mode: st.mode & 0o7777, mine: st.uid === process.getuid?.() };
  }
}
