/**
 * The publish steps of `release.yml` (docs/IMPLEMENTATION.md §23.8), run in the `publish` environment after the owner
 * approves. They resume where an earlier attempt stopped:
 *   prepare  the artifact matches its SHA256SUMS; the tag's release exists; a release an earlier attempt already
 *            published goes straight to verify when its assets' digests match SHA256SUMS, and fails otherwise.
 *   (the workflow attests SHA256SUMS' subjects with actions/attest between the two)
 *   finish   upload the three assets to the draft (--clobber), list them and refuse unless they are exactly the
 *            tarball, install.sh and SHA256SUMS with the digests SHA256SUMS names, then publish it, marked latest only
 *            when its version is the highest published (D55).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isLatestRelease } from "../../../packages/core/src/release/latest.ts";
import { releaseTagVersion } from "../../../packages/core/src/release/semver.ts";
import { ghJson, ghOk } from "./gh.mjs";

/** @typedef {import("./run.mjs").Runner} Runner */
/** @typedef {{ name: string; digest: string | null }} ReleaseAsset */
/** @typedef {{ tag: string; draft: boolean; assets: ReleaseAsset[] }} Release */
/** @typedef {{ ok: true; next: "verify" | "attest" } | { ok: false; problems: string[] }} PrepareResult */
/** @typedef {{ ok: true; latest: boolean } | { ok: false; problems: string[] }} FinishResult */

export const SUMS = "SHA256SUMS";

/** @param {string} version */
export function tarballName(version) {
  return `desk-${version}-darwin-arm64.tar.gz`;
}

/** The release's assets, in upload order: the tarball, install.sh, SHA256SUMS (§23.6). @param {string} version */
export function assetNames(version) {
  return [tarballName(version), "install.sh", SUMS];
}

/**
 * `SHA256SUMS`: one `<64 hex>  <name>` line per file (sha256sum's text mode), plain names only, each once.
 * @param {string} text
 * @returns {{ ok: true; sums: Map<string, string> } | { ok: false; problem: string }}
 */
export function parseSha256Sums(text) {
  /** @type {Map<string, string>} */
  const sums = new Map();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9][A-Za-z0-9._+-]*)$/.exec(line);
    if (match === null) return { ok: false, problem: "SHA256SUMS has a line that is not `<sha256>  <file name>`" };
    const [, digest = "", name = ""] = match;
    if (sums.has(name)) return { ok: false, problem: `SHA256SUMS names ${name} twice` };
    sums.set(name, digest);
  }
  if (sums.size === 0) return { ok: false, problem: "SHA256SUMS is empty" };
  return { ok: true, sums };
}

/** @param {Buffer} bytes */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Reads the artifact in `dir`: SHA256SUMS must name exactly the tarball and install.sh, and both files must match it.
 * @param {string} dir
 * @param {string} version
 * @returns {Promise<{ ok: true; sums: Map<string, string>; sumsDigest: string; files: string[] } | { ok: false; problems: string[] }>}
 */
export async function readArtifact(dir, version) {
  const sumsBytes = await readFile(join(dir, SUMS));
  const parsed = parseSha256Sums(sumsBytes.toString("utf8"));
  if (!parsed.ok) return { ok: false, problems: [parsed.problem] };
  const subjects = [tarballName(version), "install.sh"];
  const named = [...parsed.sums.keys()].sort();
  if (named.join("\n") !== [...subjects].sort().join("\n")) {
    return { ok: false, problems: [`SHA256SUMS names ${named.join(", ")}, not exactly ${subjects.join(" and ")}`] };
  }
  /** @type {string[]} */
  const problems = [];
  for (const name of subjects) {
    if (sha256(await readFile(join(dir, name))) !== parsed.sums.get(name)) {
      problems.push(`${name} does not match its line in SHA256SUMS`);
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, sums: parsed.sums, sumsDigest: sha256(sumsBytes), files: assetNames(version).map((name) => join(dir, name)) };
}

/**
 * Why a release's assets are not exactly the three files with the digests SHA256SUMS names (and SHA256SUMS' own).
 * @param {{ assets: ReleaseAsset[]; sums: Map<string, string>; sumsDigest: string; version: string }} input
 * @returns {string[]}
 */
export function assetProblems({ assets, sums, sumsDigest, version }) {
  /** @type {string[]} */
  const problems = [];
  const wanted = new Map([...sums.entries(), [SUMS, sumsDigest]]);
  const names = assets.map((asset) => asset.name).sort();
  if (names.join("\n") !== [...assetNames(version)].sort().join("\n")) {
    problems.push(`the release's assets are ${names.join(", ") || "none"}, not exactly ${assetNames(version).join(", ")}`);
  }
  for (const asset of assets) {
    const digest = wanted.get(asset.name);
    if (digest === undefined) continue;
    if (asset.digest === null) problems.push(`GitHub reports no digest for ${asset.name}`);
    else if (asset.digest !== `sha256:${digest}`) problems.push(`${asset.name}'s digest is not the one SHA256SUMS names`);
  }
  return problems;
}

/**
 * Every release, drafts included (the publish job's token may see them), in a plain shape.
 * @param {Runner} gh
 * @param {string} repository
 * @returns {Promise<Release[]>}
 */
export async function listReleases(gh, repository) {
  const pages = await ghJson(gh, ["api", "--method", "GET", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`]);
  /** @type {Release[]} */
  const releases = [];
  for (const entry of Array.isArray(pages) ? pages.flat() : []) {
    const { tag_name: tag, draft, assets } = /** @type {{ tag_name?: unknown; draft?: unknown; assets?: unknown }} */ (entry ?? {});
    if (typeof tag !== "string") continue;
    releases.push({
      tag,
      draft: draft === true,
      assets: (Array.isArray(assets) ? assets : []).map((asset) => {
        const { name, digest } = /** @type {{ name?: unknown; digest?: unknown }} */ (asset ?? {});
        return { name: String(name), digest: typeof digest === "string" ? digest : null };
      }),
    });
  }
  return releases;
}

/** @param {string} tag */
function noRelease(tag) {
  return `there is no release for ${tag}; release-please drafts it with its tag`;
}

/**
 * Steps 1 and 2: check the artifact against SHA256SUMS, find the tag's release, and resume.
 * @param {Runner} gh
 * @param {{ repository: string; tag: string; dir: string }} input
 * @returns {Promise<PrepareResult>}
 */
export async function prepare(gh, { repository, tag, dir }) {
  const version = releaseTagVersion(tag);
  if (version === null) return { ok: false, problems: [`${tag} is not vMAJOR.MINOR.PATCH`] };
  const artifact = await readArtifact(dir, version);
  if (!artifact.ok) return artifact;
  const release = (await listReleases(gh, repository)).find((r) => r.tag === tag);
  if (release === undefined) return { ok: false, problems: [noRelease(tag)] };
  if (release.draft) return { ok: true, next: "attest" };
  const problems = assetProblems({ assets: release.assets, sums: artifact.sums, sumsDigest: artifact.sumsDigest, version });
  return problems.length === 0 ? { ok: true, next: "verify" } : { ok: false, problems: [`${tag} is already published, and differs:`, ...problems] };
}

/**
 * Steps 3 (after the workflow attested) to 5: upload, check, publish.
 * @param {Runner} gh
 * @param {{ repository: string; tag: string; dir: string }} input
 * @returns {Promise<FinishResult>}
 */
export async function finish(gh, { repository, tag, dir }) {
  const version = releaseTagVersion(tag);
  if (version === null) return { ok: false, problems: [`${tag} is not vMAJOR.MINOR.PATCH`] };
  const artifact = await readArtifact(dir, version);
  if (!artifact.ok) return artifact;
  const before = (await listReleases(gh, repository)).find((r) => r.tag === tag);
  if (before === undefined) return { ok: false, problems: [noRelease(tag)] };
  if (!before.draft) return { ok: false, problems: [`${tag} is already published; run prepare, which goes to verify`] };

  await ghOk(gh, ["release", "upload", tag, "--repo", repository, "--clobber", ...artifact.files]);

  const releases = await listReleases(gh, repository);
  const draft = releases.find((r) => r.tag === tag);
  if (draft === undefined) return { ok: false, problems: [noRelease(tag)] };
  const problems = assetProblems({ assets: draft.assets, sums: artifact.sums, sumsDigest: artifact.sumsDigest, version });
  if (problems.length > 0) return { ok: false, problems };

  const published = releases.flatMap((r) => {
    const v = r.draft || r.tag === tag ? null : releaseTagVersion(r.tag);
    return v === null ? [] : [v];
  });
  const latest = isLatestRelease(version, published);
  await ghOk(gh, ["release", "edit", tag, "--repo", repository, "--draft=false", `--latest=${latest}`]);
  return { ok: true, latest };
}
