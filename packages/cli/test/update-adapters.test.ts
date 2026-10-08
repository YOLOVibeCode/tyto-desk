import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TarArchive, findGh } from "@desk/node";
import { GhProvenance } from "../src/provenance.ts";
import { GitHubReleaseFeed } from "../src/release-feed.ts";
import { fakeExecutable } from "../../../test/fixtures/fake-exec.ts";

const REPO = "YOLOVibeCode/tyto-desk";
const COMMIT = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
const MAIN = "9".repeat(40);
const TAG_OBJECT = "7".repeat(40);
const NO_GH = "/nonexistent/gh";
const run = promisify(execFile);

describe("provenance through gh (docs/IMPLEMENTATION.md §23.5)", () => {
  it.each([
    ["stable", { workflow: "release.yml" as const, ref: "refs/tags/v0.4.0" }],
    ["edge", { workflow: "edge.yml" as const, ref: "refs/heads/main" }],
  ])("the provenance check passes --cert-identity, --source-ref, --source-digest and --deny-self-hosted-runners for %s", async (_, input) => {
    const gh = await fakeExecutable("gh", [{ match: ["attestation"], stdout: "" }]);

    expect(await new GhProvenance({ gh: gh.path, repo: REPO, env: { HOME: "/Users/alex" } }).attest("/d/desk.tar.gz", { ...input, commit: COMMIT })).toBe(true);
    expect((await gh.calls())[0]?.argv).toEqual([
      "attestation",
      "verify",
      "/d/desk.tar.gz",
      "--repo",
      REPO,
      "--cert-identity",
      `https://github.com/${REPO}/.github/workflows/${input.workflow}@${input.ref}`,
      "--source-ref",
      input.ref,
      "--source-digest",
      COMMIT,
      "--deny-self-hosted-runners",
    ]);
  });

  it("provenance refuses a ref or commit that is not exactly a release tag, main, and a full sha", async () => {
    const gh = await fakeExecutable("gh", [{ match: ["attestation"], stdout: "" }]);
    const provenance = new GhProvenance({ gh: gh.path, repo: REPO, env: {} });

    expect(await provenance.attest("/d/x", { workflow: "release.yml", ref: "refs/tags/v0.4.0-rc.1", commit: COMMIT })).toBe(false);
    expect(await provenance.attest("/d/x", { workflow: "edge.yml", ref: "refs/heads/main", commit: "abc" })).toBe(false);
    expect(await gh.calls()).toEqual([]);
  });

  it.each([
    ["gh version 2.102.0 (2026-01-01)", 0, { ok: true }],
    ["gh version 2.101.9 (2025-12-01)", 0, { ok: false, reason: "old" }],
    ["gh version 2.102.0 (2026-01-01)", 1, { ok: false, reason: "signed-out" }],
  ])("gh reports %s with auth status %i as %j", async (version, auth, status) => {
    const gh = await fakeExecutable("gh", [
      { match: ["--version"], stdout: `${version}\n` },
      { match: ["auth", "status"], stdout: "", exit: auth },
    ]);

    expect(await new GhProvenance({ gh: gh.path, repo: REPO, env: {} }).gh()).toEqual(status);
  });

  it("a missing gh is reported as missing", async () => {
    expect(await new GhProvenance({ gh: "/nonexistent/gh", repo: REPO, env: {} }).gh()).toEqual({ ok: false, reason: "missing" });
  });
});

describe("a runtime tarball", () => {
  it("TarArchive extracts the one runtime directory a tarball holds", async () => {
    const source = await mkdtemp(join(tmpdir(), "tar-src-"));
    await mkdir(join(source, "desk-0.4.0"));
    await writeFile(join(source, "desk-0.4.0", "version.json"), "{}");
    const tarball = join(source, "desk.tar.gz");
    await run("tar", ["-czf", tarball, "-C", source, "desk-0.4.0"]);
    const dir = join(await mkdtemp(join(tmpdir(), "tar-out-")), "x");

    const runtime = await new TarArchive("tar").extract(tarball, dir);

    expect(runtime).toBe(join(dir, "desk-0.4.0"));
    expect(await readFile(join(dir, "desk-0.4.0", "version.json"), "utf8")).toBe("{}");
  });

  it("TarArchive refuses a tarball that holds a link, and extracts nothing", async () => {
    const source = await mkdtemp(join(tmpdir(), "tar-src-"));
    await mkdir(join(source, "desk-0.4.0"));
    await symlink("/dev/zero", join(source, "desk-0.4.0", "version.json"));
    const tarball = join(source, "desk.tar.gz");
    await run("tar", ["-czf", tarball, "-C", source, "desk-0.4.0"]);
    const dir = join(await mkdtemp(join(tmpdir(), "tar-out-")), "x");

    expect(await new TarArchive("tar").extract(tarball, dir)).toBeNull();
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it("TarArchive refuses a file that is not gzip before tar reads it", async () => {
    const tar = await fakeExecutable("tar", [{ match: ["-tzf"], stdout: "desk/\n" }]);
    const file = join(await mkdtemp(join(tmpdir(), "tar-src-")), "desk.tar.gz");
    await writeFile(file, "PK\u0003\u0004 a zip, not a gzip");

    expect(await new TarArchive(tar.path).extract(file, join(await mkdtemp(join(tmpdir(), "tar-out-")), "x"))).toBeNull();
    expect(await tar.calls()).toEqual([]);
  });

  it.each(["../evil", "/etc/passwd", "desk/../../evil"])("TarArchive refuses a member named %s and extracts nothing", async (member) => {
    const tar = await fakeExecutable("tar", [{ match: ["-tzf"], stdout: `desk/\n${member}\n` }]);
    const dir = join(await mkdtemp(join(tmpdir(), "tar-out-")), "x");
    const tarball = join(await mkdtemp(join(tmpdir(), "tar-src-")), "desk.tar.gz");
    await writeFile(tarball, gzipSync("a tarball"));

    expect(await new TarArchive(tar.path).extract(tarball, dir)).toBeNull();
    expect((await tar.calls()).map((call) => call.argv[0])).toEqual(["-tzf"]);
  });
});

describe("the release feed", () => {
  let server: Server;
  let api = "";
  const seen: string[] = [];
  const tarball = "the tarball's bytes";
  const sums = `${createHash("sha256").update(tarball).digest("hex")}  desk-0.4.0-darwin-arm64.tar.gz\n`;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
      };
      const base = `/repos/${REPO}`;
      const release = { tag_name: "v0.4.0", assets: [
        { name: "desk-0.4.0-darwin-arm64.tar.gz", browser_download_url: `${api}/download/tarball` },
        { name: "SHA256SUMS", browser_download_url: `${api}/download/sums` },
      ] };
      if (req.url === `${base}/releases/latest` || req.url === `${base}/releases/tags/v0.4.0` || req.url === `${base}/releases/tags/v0.4.1`) {
        return reply(200, req.url.endsWith("v0.4.1") ? { ...release, tag_name: "v0.4.1" } : release);
      }
      if (req.url === `${base}/git/ref/tags/v0.4.0`) return reply(200, { object: { type: "commit", sha: COMMIT } });
      // v0.4.1 is an annotated tag: its ref names a tag object, which names the commit.
      if (req.url === `${base}/git/ref/tags/v0.4.1`) return reply(200, { object: { type: "tag", sha: TAG_OBJECT } });
      if (req.url === `${base}/git/tags/${TAG_OBJECT}`) return reply(200, { object: { type: "commit", sha: COMMIT } });
      if (req.url === `${base}/branches/main`) return reply(200, { commit: { sha: MAIN } });
      if (req.url === `${base}/compare/${COMMIT}...${MAIN}`) return reply(200, { status: "ahead" });
      if (req.url?.startsWith(`${base}/compare/`)) return reply(200, { status: "diverged" });
      seen.push(req.url ?? "");
      if (req.url === "/download/tarball") return reply(200, tarball);
      if (req.url === "/download/sums") return reply(200, sums);
      return reply(404, { message: "Not Found" });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("the feed reads releases/latest and its tag's commit through git/ref/tags, never a branch of that name, without a token", async () => {
    const feed = new GitHubReleaseFeed({ api, repo: REPO, asset: "darwin-arm64", gh: NO_GH, env: {} });

    expect(await feed.latest("stable")).toEqual({ tag: "v0.4.0", version: "0.4.0", channel: "stable", commit: COMMIT });
    expect(await feed.find("0.9.9")).toBeNull();
    expect(seen.filter((url) => url.includes("/commits/"))).toEqual([]);
  });

  it("the feed peels an annotated tag to its commit", async () => {
    const feed = new GitHubReleaseFeed({ api, repo: REPO, asset: "darwin-arm64", gh: NO_GH, env: {} });

    expect(await feed.find("0.4.1")).toEqual({ tag: "v0.4.1", version: "0.4.1", channel: "stable", commit: COMMIT });
  });

  it("the feed compares a commit with the head of branches/main, never a ref named main", async () => {
    const feed = new GitHubReleaseFeed({ api, repo: REPO, asset: "darwin-arm64", gh: NO_GH, env: {} });

    expect(await feed.onMain(COMMIT)).toBe(true);
    expect(await feed.onMain(MAIN)).toBe(true);
    expect(await feed.onMain("1".repeat(40))).toBe(false);
  });

  it("the feed counts a commit ahead of another only when compare says ahead", async () => {
    const feed = new GitHubReleaseFeed({ api, repo: REPO, asset: "darwin-arm64", gh: NO_GH, env: {} });

    expect(await feed.ahead(COMMIT, MAIN)).toBe(true);
    expect(await feed.ahead(MAIN, COMMIT)).toBe(false);
    expect(await feed.ahead("abc", MAIN)).toBe(false);
  });

  it("the feed downloads the release's tarball and SHA256SUMS into a 0700 directory", async () => {
    const feed = new GitHubReleaseFeed({ api, repo: REPO, asset: "darwin-arm64", gh: NO_GH, env: {} });
    const dir = join(await mkdtemp(join(tmpdir(), "feed-")), "d");

    const got = await feed.fetch({ tag: "v0.4.0", version: "0.4.0", channel: "stable", commit: COMMIT }, "darwin-arm64", dir);

    expect(got).toEqual({ tarball: join(dir, "desk-0.4.0-darwin-arm64.tar.gz"), sums: join(dir, "SHA256SUMS") });
    expect(await readFile(join(dir, "SHA256SUMS"), "utf8")).toBe(sums);
  });

  it("the feed takes the newest successful edge run on main whose artifact is at most 300 MB, and names its version as edge.yml does", async () => {
    const pkg = Buffer.from(JSON.stringify({ version: "0.4.0" })).toString("base64");
    const gh = await fakeExecutable("gh", [
      { match: ["run", "list"], stdout: JSON.stringify([{ databaseId: 9003, number: 59, headSha: "c".repeat(40) }, { databaseId: 9002, number: 58, headSha: "b".repeat(40) }, { databaseId: 9001, number: 57, headSha: COMMIT }]) },
      { match: ["api", `repos/${REPO}/actions/runs/9003/artifacts`], stdout: `desk-edge-darwin-arm64\t${301 * 1024 * 1024}\n` },
      { match: ["api", `repos/${REPO}/actions/runs/9002/artifacts`], stdout: "something-else\t1000\n" },
      { match: ["api", `repos/${REPO}/actions/runs/9001/artifacts`], stdout: "desk-edge-darwin-arm64\t41943040\n" },
      { match: ["api", `repos/${REPO}/contents/package.json?ref=${COMMIT}`], stdout: `${pkg}\n` },
    ]);
    const feed = new GitHubReleaseFeed({ api, repo: REPO, asset: "darwin-arm64", gh: gh.path, env: {} });

    expect(await feed.latest("edge")).toEqual({ tag: "0.4.1-edge.57+0f1e2d3", version: "0.4.1-edge.57+0f1e2d3", channel: "edge", commit: COMMIT, run: 9001 });
    expect((await gh.calls())[0]?.argv).toEqual(["run", "list", "--repo", REPO, "--workflow", "edge.yml", "--branch", "main", "--status", "success", "--limit", "20", "--json", "databaseId,number,headSha"]);
  });

  it.each([
    ["holds a third file", ["desk-0.4.1-edge.57+0f1e2d3-darwin-arm64.tar.gz", "SHA256SUMS", "extra"]],
    ["lacks SHA256SUMS", ["desk-0.4.1-edge.57+0f1e2d3-darwin-arm64.tar.gz"]],
  ])("the feed refuses an edge artifact that %s", async (_, files) => {
    const bin = await mkdtemp(join(tmpdir(), "edge-gh-"));
    const writes = files.map((name) => `: > "$dir/${name}"`).join("\n");
    await writeFile(join(bin, "gh"), `#!/bin/sh\ndir=""; prev=""\nfor arg in "$@"; do [ "$prev" = "--dir" ] && dir=$arg; prev=$arg; done\n${writes}\n`);
    await chmod(join(bin, "gh"), 0o755);
    const feed = new GitHubReleaseFeed({ api, repo: REPO, asset: "darwin-arm64", gh: join(bin, "gh"), env: {} });
    const dir = join(await mkdtemp(join(tmpdir(), "feed-")), "d");
    const version = "0.4.1-edge.57+0f1e2d3";

    expect(await feed.fetch({ tag: version, version, channel: "edge", commit: COMMIT, run: 9001 }, "darwin-arm64", dir)).toBeNull();
  });
});

describe("which runtime desk update takes", () => {
  it.each([
    ["macOS on arm64", {}, "darwin", "arm64", "darwin-arm64"],
    ["macOS on x64", {}, "darwin", "x64", null],
    ["Linux outside the test container", {}, "linux", "arm64", null],
    ["the Linux test container", { DESK_IN_CONTAINER: "1" }, "linux", "arm64", "linux-arm64"],
  ])("desk update on %s takes %s", async (_, env, platform, arch, asset) => {
    const { updateAsset } = await import("../src/update.ts");

    expect(updateAsset(env, platform, arch)).toBe(asset);
  });

  it.each([
    ["the Linux test container", { DESK_IN_CONTAINER: "1", DESK_RELEASE_API: "http://127.0.0.1:9/" }, "linux", "http://127.0.0.1:9/"],
    ["a Mac that claims to be the container", { DESK_IN_CONTAINER: "1", DESK_RELEASE_API: "https://evil.example" }, "darwin", undefined],
    ["Linux outside the container", { DESK_RELEASE_API: "https://evil.example" }, "linux", undefined],
  ])("on %s desk update takes its release API base from DESK_RELEASE_API only in the Linux test container", async (_, env, platform, api) => {
    const { releaseApi } = await import("../src/update.ts");

    expect(releaseApi(env, platform)).toBe(api);
  });
});

describe("which gh desk update trusts", () => {
  it("findGh never takes gh from PATH or DESK_GH on a Mac", async () => {
    const dir = await mkdtemp(join(tmpdir(), "path-gh-"));
    await writeFile(join(dir, "gh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(dir, "gh"), 0o755);

    const gh = await findGh({ PATH: dir, DESK_IN_CONTAINER: "1", DESK_GH: join(dir, "gh") }, "darwin");

    expect(["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]).toContain(gh);
  });

  it("findGh takes DESK_GH inside the Linux test container", async () => {
    const dir = await mkdtemp(join(tmpdir(), "container-gh-"));
    await writeFile(join(dir, "gh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(dir, "gh"), 0o755);

    expect(await findGh({ DESK_IN_CONTAINER: "1", DESK_GH: join(dir, "gh") }, "linux")).toBe(join(dir, "gh"));
  });
});
