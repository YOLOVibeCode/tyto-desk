/**
 * Which Dependabot pull requests merge themselves (docs/IMPLEMENTATION.md §23.7, D44): an npm `direct:development`
 * update of `@types/*`, `typescript`, `vitest` or `yaml`, of type `version-update:semver-patch`. A group passes only when
 * every member does. These tools run in tests and type checks, never while the runtime is packed, and nothing they
 * provide ships. Everything else waits for the owner, esbuild above all, which writes every byte Desk ships.
 * Dependency-free: `dependabot-auto-merge.yml` runs the base branch's copy on fetch-metadata's output.
 */

const ALLOWED_NAMES = new Set(["typescript", "vitest", "yaml"]);
const ALLOWED_TEXT = "@types/*, typescript, vitest, yaml";

/** A package name as it may appear in a workflow output and a comment: one line, no markup. @param {unknown} name */
export function safeName(name) {
  return String(name).replace(/[^A-Za-z0-9@._/~-]/g, "").slice(0, 214) || "(unnamed)";
}

/** @param {Record<string, unknown>} update */
function allowed(update) {
  const name = update.dependencyName;
  return (
    update.packageEcosystem === "npm_and_yarn" &&
    update.dependencyType === "direct:development" &&
    update.updateType === "version-update:semver-patch" &&
    typeof name === "string" &&
    (ALLOWED_NAMES.has(name) || /^@types\/[a-z0-9._~-]+$/.test(name))
  );
}

/**
 * @param {unknown} updates fetch-metadata's `updated-dependencies-json`, parsed
 * @returns {{ merge: boolean; reason: string }}
 */
export function automergeDecision(updates) {
  if (!Array.isArray(updates) || updates.length === 0) {
    return { merge: false, reason: "Dependabot reported no updated dependency" };
  }
  for (const update of updates) {
    const record = typeof update === "object" && update !== null ? /** @type {Record<string, unknown>} */ (update) : {};
    if (!allowed(record)) {
      return {
        merge: false,
        reason: `${safeName(record.dependencyName)} is not a patch update of an allowlisted dev tool (${ALLOWED_TEXT})`,
      };
    }
  }
  return { merge: true, reason: "patch updates of allowlisted dev tools" };
}
