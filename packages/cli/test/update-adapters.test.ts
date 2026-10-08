import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TarArchive } from "@desk/node";
import { GhProvenance } from "../src/provenance.ts";
import { GitHubReleaseFeed } from "../src/release-feed.ts";
import { fakeExecutable } from "../../../test/fixtures/fake-exec.ts";

const REPO = "YOLOVibeCode/tyto-desk";
const COMMIT = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
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

  it.each(["../evil", "/etc/passwd", "desk/../../evil"])("TarArchive refuses a member named %s and extracts nothing", async (member) => {
    const tar = await fakeExecutable("tar", [{ match: ["-tzf"], stdout: `desk/\n${member}\n` }]);
    const dir = join(await mkdtemp(join(tmpdir(), "tar-out-")), "x");

    expect(await new TarArchive(tar.path).extract("/d/desk.tar.gz", dir)).toBeNull();
    expect((await tar.calls()).map((call) => call.argv[0])).toEqual(["-tzf"]);
  });
});

describe("the release feed", () => {
  let server: Server;
  let api = "";
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
      if (req.url === `${base}/releases/latest` || req.url === `${base}/releases/tags/v0.4.0`) return reply(200, release);
      if (req.url === `${base}/commits/v0.4.0`) return reply(200, { sha: COMMIT });
      if (req.url === `${base}/compare/${COMMIT}...main`) return reply(200, { status: "ahead" });
      if (req.url?.startsWith(`${base}/compare/`)) return reply(200, { status: "diverged" });
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

  it("the feed reads releases/latest and the commit GitHub reports for its tag, without a token", async () => {
    const feed = new GitHubReleaseFeed({ api, repo: REPO, asset: "darwin-arm64", env: {} });

    expect(await feed.latest("stable")).toEqual({ tag: "v0.4.0", version: "0.4.0", channel: "stable", commit: COMMIT });
    expect(await feed.find("0.9.9")).toBeNull();
  });

  it("the feed asks compare whether a commit is on main", async () => {
    const feed = new GitHubReleaseFeed({ api, repo: REPO, asset: "darwin-arm64", env: {} });

    expect(await feed.onMain(COMMIT)).toBe(true);
    expect(await feed.onMain("1".repeat(40))).toBe(false);
  });

  it("the feed downloads the release's tarball and SHA256SUMS into a 0700 directory", async () => {
    const feed = new GitHubReleaseFeed({ api, repo: REPO, asset: "darwin-arm64", env: {} });
    const dir = join(await mkdtemp(join(tmpdir(), "feed-")), "d");

    const got = await feed.fetch({ tag: "v0.4.0", version: "0.4.0", channel: "stable", commit: COMMIT }, "darwin-arm64", dir);

    expect(got).toEqual({ tarball: join(dir, "desk-0.4.0-darwin-arm64.tar.gz"), sums: join(dir, "SHA256SUMS") });
    expect(await readFile(join(dir, "SHA256SUMS"), "utf8")).toBe(sums);
  });

  it("the feed takes the newest successful edge run on main that has the artifact, and names its version as edge.yml does", async () => {
    const pkg = Buffer.from(JSON.stringify({ version: "0.4.0" })).toString("base64");
    const gh = await fakeExecutable("gh", [
      { match: ["run", "list"], stdout: JSON.stringify([{ databaseId: 9002, number: 58, headSha: "b".repeat(40) }, { databaseId: 9001, number: 57, headSha: COMMIT }]) },
      { match: ["api", `repos/${REPO}/actions/runs/9002/artifacts`], stdout: "something-else\n" },
      { match: ["api", `repos/${REPO}/actions/runs/9001/artifacts`], stdout: "desk-edge-darwin-arm64\n" },
      { match: ["api", `repos/${REPO}/contents/package.json?ref=${COMMIT}`], stdout: `${pkg}\n` },
    ]);
    const feed = new GitHubReleaseFeed({ api, repo: REPO, asset: "darwin-arm64", gh: gh.path, env: {} });

    expect(await feed.latest("edge")).toEqual({ tag: "0.4.1-edge.57+0f1e2d3", version: "0.4.1-edge.57+0f1e2d3", channel: "edge", commit: COMMIT, run: 9001 });
    expect((await gh.calls())[0]?.argv).toEqual(["run", "list", "--repo", REPO, "--workflow", "edge.yml", "--branch", "main", "--status", "success", "--limit", "20", "--json", "databaseId,number,headSha"]);
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
});
