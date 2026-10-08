import { access, constants } from "node:fs/promises";

/** Where Homebrew installs gh on Apple silicon and on Intel. */
const HOMEBREW_GH = "/opt/homebrew/bin/gh";
const GH_CANDIDATES = [HOMEBREW_GH, "/usr/local/bin/gh"];

/**
 * The gh Desk's provenance checks run (docs/IMPLEMENTATION.md §23.5): the first installed one of fixed paths, never one
 * found through PATH, where an earlier `gh` (one in `.` or a checkout's bin) could vouch for anything. Only in the Linux
 * test container may `DESK_GH` name one. When none is installed, the first candidate, which the check reports missing.
 */
export async function findGh(env: Readonly<Record<string, string | undefined>>, platform: string): Promise<string> {
  const named = platform === "linux" && env.DESK_IN_CONTAINER === "1" ? env.DESK_GH : undefined;
  const candidates = named !== undefined && named.startsWith("/") ? [named] : GH_CANDIDATES;
  for (const candidate of candidates) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return candidates[0] ?? HOMEBREW_GH;
}
