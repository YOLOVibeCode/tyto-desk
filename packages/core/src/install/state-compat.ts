import type { TextFiles } from "../ports/text-files.ts";
import type { VersionInfo } from "../version/version-info.ts";

/** The state files under `~/.desk` whose schema version a Desk version reads (version.json's `compat.state`). */
export const STATE_FILES = ["config", "layout", "panes", "installed"] as const;

/**
 * Why making `info`'s Desk current would move a state file aside (docs/IMPLEMENTATION.md §23.5 rule 6): the first
 * state file on disk whose schema version is newer than the one it reads, as a sentence; `null` when it reads them all.
 */
export async function stateTooNew(files: TextFiles, deskHome: string, info: VersionInfo): Promise<string | null> {
  const reads = (info.compat as { state?: Record<string, unknown> } | null)?.state ?? {};
  for (const name of STATE_FILES) {
    const path = `${deskHome}/${name}.json`;
    const text = await files.read(path);
    if (text === null) continue;
    let onDisk: unknown;
    try {
      onDisk = (JSON.parse(text) as { version?: unknown }).version;
    } catch {
      continue;
    }
    const readable = reads[name];
    if (typeof onDisk === "number" && typeof readable === "number" && onDisk > readable) {
      return `Desk ${info.version} reads ${name}.json version ${readable}, but ${path} is version ${onDisk}: it would move it aside`;
    }
  }
  return null;
}
