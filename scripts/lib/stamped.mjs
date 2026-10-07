/**
 * The version a runtime build takes (docs/IMPLEMENTATION.md §23.3): locally, the stamp's classification of the checkout,
 * written into dist/version.json as the stamp does; in CI, the dist/version.json the workflow's stamp step wrote, which
 * only that step can classify (a release dry run, the expected channel), checked against the commit being built.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { classifyBuild, parseVersionInfo } from "../../packages/core/src/index.ts";
import { gitEnvFrom, gitRunner, headCommit } from "../delivery/lib/git-facts.mjs";
import { REFUSAL_TEXT, gatherBuildFacts, pinnedNode, versionFile, writeVersionFile } from "../delivery/lib/stamp.mjs";

/** @typedef {import("../../packages/core/src/index.ts").VersionInfo} VersionInfo */
/** @typedef {{ ok: true; version: VersionInfo } | { ok: false; reasons: string[] }} Stamped */

/**
 * @param {{ root: string; env: Record<string, string | undefined>; allowDirty: boolean; now?: () => Date }} input
 * @returns {Promise<Stamped>}
 */
export async function stampedVersion(input) {
  const root = resolve(input.root);
  const out = join(root, "dist");
  const git = gitRunner({ cwd: root, env: gitEnvFrom(input.env) });
  if (input.env.GITHUB_ACTIONS === "true") {
    const text = await readFile(join(out, "version.json"), "utf8").catch(() => null);
    const version = text === null ? null : parseVersionInfo(text);
    if (version === null) return { ok: false, reasons: ["dist/version.json is missing or damaged: run the stamp step first"] };
    if (version.commit !== (await headCommit(git))) return { ok: false, reasons: ["dist/version.json names another commit than the one checked out"] };
    return { ok: true, version };
  }
  const facts = await gatherBuildFacts({ root, env: input.env, git, now: input.now ?? (() => new Date()), allowDirty: input.allowDirty, dryRun: false });
  if (facts.problems.length > 0) return { ok: false, reasons: facts.problems };
  const build = classifyBuild(facts.input);
  if (!build.ok) {
    const dirty = build.refusals.includes("dirty-tree") && facts.dirtyFiles !== null ? facts.dirtyFiles.map((file) => `uncommitted: ${file}`) : [];
    return { ok: false, reasons: [...build.refusals.map((refusal) => `${refusal}: ${REFUSAL_TEXT[refusal]}`), ...dirty] };
  }
  const file = versionFile(facts.input, build, await pinnedNode(root));
  await writeVersionFile(out, file);
  const version = parseVersionInfo(JSON.stringify(file));
  return version === null ? { ok: false, reasons: ["the stamp wrote a version.json that does not parse"] } : { ok: true, version };
}
