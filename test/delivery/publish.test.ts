import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { finish, parseSha256Sums, prepare } from "../../scripts/delivery/lib/publish.mjs";
import { fakeGh, ok, type GhCall } from "./fake-gh.ts";

const REPOSITORY = "YOLOVibeCode/tyto-desk";

type Asset = { name: string; digest: string | null };
type Release = { tag_name: string; draft: boolean; prerelease: boolean; assets: Asset[] };

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** The build's artifact for `version`: the tarball, install.sh, and SHA256SUMS naming both. */
async function artifact(version: string) {
  const dir = await mkdtemp(join(tmpdir(), "artifact-"));
  const tarball = `desk-${version}-darwin-arm64.tar.gz`;
  const files: Record<string, Buffer | string> = { [tarball]: randomBytes(256), "install.sh": "#!/bin/bash\necho install\n" };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, name), bytes);
  const sums = Object.entries(files)
    .map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`)
    .join("");
  await writeFile(join(dir, "SHA256SUMS"), sums);
  const digests: Record<string, string> = { "SHA256SUMS": `sha256:${sha256(sums)}` };
  for (const [name, bytes] of Object.entries(files)) digests[name] = `sha256:${sha256(bytes)}`;
  return { dir, tarball, digests };
}

/**
 * GitHub's releases for one repository. An upload attaches the files it names with their real digests, then
 * `tamper` may change what the API reports, as a race or a broken upload would.
 */
function github(releases: Release[], tamper: (assets: Asset[]) => Asset[] = (assets) => assets) {
  return fakeGh([
    {
      match: new RegExp(`^api --method GET --paginate --slurp repos/${REPOSITORY}/releases\\?per_page=100$`),
      reply: () => ok([releases]),
    },
    {
      match: /^release upload /,
      reply: (args) => {
        const tag = args[2];
        const release = releases.find((r) => r.tag_name === tag);
        if (release === undefined) return { code: 1, stdout: "", stderr: "release not found" };
        const uploaded: Asset[] = [];
        for (const path of args.slice(args.indexOf("--clobber") + 1)) {
          uploaded.push({ name: path.slice(path.lastIndexOf("/") + 1), digest: null });
        }
        release.assets = tamper(uploaded);
        return ok("");
      },
    },
    { match: /^release edit /, reply: () => ok("") },
  ]);
}

/** Fills each uploaded asset's digest from the local files, as GitHub computes it. */
async function withDigests(dir: string, assets: Asset[]): Promise<Asset[]> {
  return Promise.all(
    assets.map(async (asset) => ({ ...asset, digest: asset.digest ?? `sha256:${sha256(await readFile(join(dir, asset.name)))}` })),
  );
}

const edits = (calls: GhCall[]) => calls.filter((call) => call.args[0] === "release" && call.args[1] === "edit");
const draft = (tag: string): Release => ({ tag_name: tag, draft: true, prerelease: false, assets: [] });
const published = (tag: string, assets: Asset[] = []): Release => ({ tag_name: tag, draft: false, prerelease: false, assets });

/** Runs `finish` with uploads that the fake reports with real digests, then `tamper`. */
async function finishWith(releases: Release[], version: string, tamper?: (assets: Asset[], dir: string) => Asset[]) {
  const build = await artifact(version);
  const fake = github(releases);
  const real = fake.gh;
  const gh: typeof real = async (args, options) => {
    const result = await real(args, options);
    if (args[0] === "release" && args[1] === "upload") {
      const release = releases.find((r) => r.tag_name === `v${version}`);
      if (release !== undefined) {
        const filled = await withDigests(build.dir, release.assets);
        release.assets = tamper === undefined ? filled : tamper(filled, build.dir);
      }
    }
    return result;
  };
  const result = await finish(gh, { repository: REPOSITORY, tag: `v${version}`, dir: build.dir });
  return { result, calls: fake.calls, build };
}

describe("publish", () => {
  it.each([
    { label: "an extra asset", tamper: (assets: Asset[]) => [...assets, { name: "notes.txt", digest: `sha256:${"0".repeat(64)}` }] },
    { label: "no install.sh", tamper: (assets: Asset[]) => assets.filter((asset) => asset.name !== "install.sh") },
    { label: "a tarball whose digest is not SHA256SUMS'", tamper: (assets: Asset[]) => assets.map((a) => (a.name.endsWith(".tar.gz") ? { ...a, digest: `sha256:${"1".repeat(64)}` } : a)) },
    { label: "a SHA256SUMS that is not the one attested", tamper: (assets: Asset[]) => assets.map((a) => (a.name === "SHA256SUMS" ? { ...a, digest: `sha256:${"2".repeat(64)}` } : a)) },
    { label: "an asset whose digest GitHub did not report", tamper: (assets: Asset[]) => assets.map((a) => (a.name === "install.sh" ? { ...a, digest: null } : a)) },
  ])(
    "publish refuses a draft whose assets are not exactly the tarball, install.sh and SHA256SUMS with the digests SHA256SUMS names ($label)",
    async ({ tamper }) => {
      const { result, calls } = await finishWith([draft("v0.3.0")], "0.3.0", tamper);

      expect(result.ok).toBe(false);
      expect(edits(calls)).toEqual([]);
    },
  );

  it("publish uploads the three assets to the draft, checks them, and publishes it", async () => {
    const { result, calls, build } = await finishWith([draft("v0.3.0")], "0.3.0");

    expect(result).toEqual({ ok: true, latest: true });
    const upload = calls.find((call) => call.args[1] === "upload");
    expect(upload?.args).toEqual([
      "release",
      "upload",
      "v0.3.0",
      "--repo",
      REPOSITORY,
      "--clobber",
      join(build.dir, build.tarball),
      join(build.dir, "install.sh"),
      join(build.dir, "SHA256SUMS"),
    ]);
    expect(edits(calls).map((call) => call.args)).toEqual([
      ["release", "edit", "v0.3.0", "--repo", REPOSITORY, "--draft=false", "--latest=true"],
    ]);
  });

  it("publish goes straight to verify when an earlier attempt already published matching assets", async () => {
    const build = await artifact("0.3.0");
    const assets = Object.entries(build.digests).map(([name, digest]) => ({ name, digest }));

    const matching = await prepare(github([published("v0.3.0", assets)]).gh, { repository: REPOSITORY, tag: "v0.3.0", dir: build.dir });

    expect(matching).toEqual({ ok: true, next: "verify" });
  });

  it("publish fails when an earlier attempt published assets whose digests differ from SHA256SUMS", async () => {
    const build = await artifact("0.3.0");
    const assets = Object.entries(build.digests).map(([name, digest]) => ({ name, digest }));
    const changed = assets.map((a) => (a.name === "install.sh" ? { ...a, digest: `sha256:${"3".repeat(64)}` } : a));

    const mismatch = await prepare(github([published("v0.3.0", changed)]).gh, { repository: REPOSITORY, tag: "v0.3.0", dir: build.dir });

    expect(mismatch).toEqual({ ok: false, problems: ["v0.3.0 is already published, and differs:", "install.sh's digest is not the one SHA256SUMS names"] });
  });

  it("publish attests a tag whose release is still a draft", async () => {
    const build = await artifact("0.3.0");

    const pending = await prepare(github([draft("v0.3.0")]).gh, { repository: REPOSITORY, tag: "v0.3.0", dir: build.dir });

    expect(pending).toEqual({ ok: true, next: "attest" });
  });

  it("publish refuses a tag with no release before it attests or uploads anything", async () => {
    const build = await artifact("0.3.0");
    const fake = github([published("v0.2.9")]);

    const missing = await prepare(fake.gh, { repository: REPOSITORY, tag: "v0.3.0", dir: build.dir });

    expect(missing).toEqual({ ok: false, problems: ["there is no release for v0.3.0; release-please drafts it with its tag"] });
    expect(fake.calls.map((call) => call.args.slice(0, 2).join(" "))).toEqual(["api --method"]);
  });

  it("publish marks a release latest only when its version is the highest published", async () => {
    const older = await finishWith([published("v0.3.0"), published("v0.10.0"), draft("v0.9.1")], "0.9.1");
    expect(older.result).toEqual({ ok: true, latest: false });
    expect(edits(older.calls)[0]?.args.at(-1)).toBe("--latest=false");

    const newer = await finishWith([published("v0.3.0"), published("v0.10.0"), draft("v0.10.1"), draft("v0.11.0")], "0.10.1");
    expect(newer.result).toEqual({ ok: true, latest: true });
    expect(edits(newer.calls)[0]?.args.at(-1)).toBe("--latest=true");
  });

  it("publish refuses an artifact whose files do not match its SHA256SUMS", async () => {
    const build = await artifact("0.3.0");
    await writeFile(join(build.dir, "install.sh"), "#!/bin/bash\necho changed\n");

    const result = await prepare(github([draft("v0.3.0")]).gh, { repository: REPOSITORY, tag: "v0.3.0", dir: build.dir });

    expect(result).toEqual({ ok: false, problems: ["install.sh does not match its line in SHA256SUMS"] });
  });

  it.each([
    ["a line without two spaces", `${"a".repeat(64)} desk.tar.gz\n`],
    ["a short digest", `${"a".repeat(63)}  desk.tar.gz\n`],
    ["a path", `${"a".repeat(64)}  ../desk.tar.gz\n`],
    ["a name twice", `${"a".repeat(64)}  x\n${"b".repeat(64)}  x\n`],
    ["no lines", ""],
  ])("SHA256SUMS refuses %s", (_label, text) => {
    expect(parseSha256Sums(text).ok).toBe(false);
  });
});
