/** The longest branch slug a dev version carries. */
export const BRANCH_SLUG_MAX = 40;

/**
 * A branch name as a SemVer prerelease identifier (docs/IMPLEMENTATION.md §23.3): lowercase; every run of characters
 * outside `[a-z0-9]` becomes `-`; trimmed of `-`, cut to 40 characters (and trimmed again, so a cut never leaves a
 * trailing `-`); `detached` when nothing is left or there is no branch; prefixed `b` when all digits, because a numeric
 * identifier would sort as a number and must not have a leading zero.
 */
export function branchSlug(branch: string | null): string {
  const slug = (branch ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, BRANCH_SLUG_MAX)
    .replace(/-+$/, "");
  if (slug === "") return "detached";
  return /^\d+$/.test(slug) ? `b${slug}` : slug;
}
