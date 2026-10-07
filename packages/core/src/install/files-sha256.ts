/** The name of the list itself, which it never lists. */
export const FILES_SHA256 = "files.sha256";

const LINE = /^([0-9a-f]{64}) {2}(.+)$/;

/** A path inside the runtime: relative, `/`-separated, with no empty, `.` or `..` segment. */
function isInsidePath(path: string): boolean {
  return !path.startsWith("/") && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * `files.sha256` (docs/IMPLEMENTATION.md §15.1, §23.4): one `<sha256>  <path>` line per file of the runtime, as
 * `sha256sum` writes it, sorted by path in code-unit order. The build id is this text's own sha256.
 */
export function formatFilesSha256(digests: ReadonlyMap<string, string>): string {
  const paths = [...digests.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return paths.map((path) => `${digests.get(path) ?? ""}  ${path}\n`).join("");
}

/**
 * The digests `files.sha256` lists, by path, or `null` when any line is malformed, a path leaves the runtime or repeats,
 * it lists itself, or it lists nothing: a runtime whose list cannot be trusted is never installed.
 */
export function parseFilesSha256(text: string): Map<string, string> | null {
  const digests = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const match = LINE.exec(line);
    if (match === null) return null;
    const [, digest = "", path = ""] = match;
    if (!isInsidePath(path) || path === FILES_SHA256 || digests.has(path)) return null;
    digests.set(path, digest);
  }
  return digests.size === 0 ? null : digests;
}
