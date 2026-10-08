import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseSemver, type ReleaseFeed, type ReleaseRef, type Unreachable } from "@desk/core";
import { assertPathAllowed, runArgv } from "@desk/node";

/** §23.5: 30 s per call, 300 MB at most. */
const CALL_MS = 30_000;
const DOWNLOAD_MAX = 300 * 1024 * 1024;

type Json = Record<string, unknown>;

function nextPatch(base: string): string | null {
  const parsed = parseSemver(base);
  return parsed === null || parsed.prerelease.length > 0 ? null : `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

/**
 * Where updates come from (docs/IMPLEMENTATION.md §23.5). Stable: GitHub's REST API without a token (`releases/latest`,
 * `releases/tags/v<version>`, `commits/<tag>`, `compare/<commit>...main`) and the release's assets. Edge: `gh run list`
 * for the newest successful `edge.yml` run on `main` that has the artifact, its version as edge.yml names it
 * (`<next patch of package.json>-edge.<run number>+<sha7>`), and `gh run download`.
 */
export class GitHubReleaseFeed implements ReleaseFeed {
  private readonly api: string;
  private readonly repo: string;
  private readonly asset: string;
  private readonly gh: string;
  private readonly env: Record<string, string>;

  constructor(input: { api?: string; repo: string; asset: string; gh?: string; env: Readonly<Record<string, string | undefined>> }) {
    this.api = (input.api ?? "https://api.github.com").replace(/\/+$/, "");
    this.repo = input.repo;
    this.asset = input.asset;
    this.gh = input.gh ?? "gh";
    this.env = {};
    for (const name of ["HOME", "PATH", "USER", "TMPDIR", "LANG", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"]) {
      const value = input.env[name];
      if (value !== undefined) this.env[name] = value;
    }
  }

  private async get(path: string): Promise<Json | null | Unreachable> {
    const answer = await fetch(`${this.api}/repos/${this.repo}/${path}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "tyto-desk" },
      signal: AbortSignal.timeout(CALL_MS),
    }).catch(() => null);
    if (answer === null) return "unreachable";
    if (answer.status === 404) return null;
    if (!answer.ok) return "unreachable";
    const body: unknown = await answer.json().catch(() => null);
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Json) : null;
  }

  private async release(body: Json | null | Unreachable): Promise<ReleaseRef | null | Unreachable> {
    if (body === null || body === "unreachable") return body;
    const tag = body.tag_name;
    if (typeof tag !== "string") return null;
    const commit = await this.get(`commits/${encodeURIComponent(tag)}`);
    if (commit === null || commit === "unreachable") return commit;
    const sha = commit.sha;
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) return null;
    return { tag, version: tag.replace(/^v/, ""), channel: "stable", commit: sha };
  }

  async latest(channel: "stable" | "edge"): Promise<ReleaseRef | null | Unreachable> {
    if (channel === "stable") return this.release(await this.get("releases/latest"));
    const runs = await runArgv(
      this.gh,
      ["run", "list", "--repo", this.repo, "--workflow", "edge.yml", "--branch", "main", "--status", "success", "--limit", "20", "--json", "databaseId,number,headSha"],
      { env: this.env, timeoutMs: CALL_MS },
    );
    if (runs.code !== 0) return "unreachable";
    let listed: unknown;
    try {
      listed = JSON.parse(runs.stdout);
    } catch {
      return null;
    }
    for (const run of Array.isArray(listed) ? (listed as Json[]) : []) {
      const { databaseId, number, headSha } = run;
      if (typeof databaseId !== "number" || typeof number !== "number" || typeof headSha !== "string" || !/^[0-9a-f]{40}$/.test(headSha)) continue;
      const artifacts = await runArgv(this.gh, ["api", `repos/${this.repo}/actions/runs/${databaseId}/artifacts`, "--jq", ".artifacts[].name"], { env: this.env, timeoutMs: CALL_MS });
      if (artifacts.code !== 0 || !artifacts.stdout.split("\n").includes(`desk-edge-${this.asset}`)) continue;
      const manifest = await runArgv(this.gh, ["api", `repos/${this.repo}/contents/package.json?ref=${headSha}`, "--jq", ".content"], { env: this.env, timeoutMs: CALL_MS });
      if (manifest.code !== 0) return "unreachable";
      let base: unknown;
      try {
        base = (JSON.parse(Buffer.from(manifest.stdout.trim(), "base64").toString("utf8")) as { version?: unknown }).version;
      } catch {
        continue;
      }
      const next = typeof base === "string" ? nextPatch(base) : null;
      if (next === null) continue;
      const version = `${next}-edge.${number}+${headSha.slice(0, 7)}`;
      return { tag: version, version, channel: "edge", commit: headSha, run: databaseId };
    }
    return null;
  }

  async find(version: string): Promise<ReleaseRef | null | Unreachable> {
    if (parseSemver(version) === null) return null;
    return this.release(await this.get(`releases/tags/v${encodeURIComponent(version)}`));
  }

  async onMain(commit: string): Promise<boolean | Unreachable> {
    if (!/^[0-9a-f]{40}$/.test(commit)) return false;
    const compared = await this.get(`compare/${commit}...main`);
    if (compared === "unreachable") return "unreachable";
    return compared !== null && (compared.status === "ahead" || compared.status === "identical");
  }

  async fetch(ref: ReleaseRef, asset: string, dir: string): Promise<{ tarball: string; sums: string } | null | Unreachable> {
    await assertPathAllowed(dir);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tarballName = `desk-${ref.version}-${asset}.tar.gz`;
    if (ref.channel === "edge") {
      if (ref.run === undefined) return null;
      const got = await runArgv(this.gh, ["run", "download", String(ref.run), "--repo", this.repo, "--name", `desk-edge-${asset}`, "--dir", dir], {
        env: this.env,
        timeoutMs: 5 * 60_000,
      });
      if (got.code !== 0) return "unreachable";
      return { tarball: join(dir, tarballName), sums: join(dir, "SHA256SUMS") };
    }
    const release = await this.get(`releases/tags/${encodeURIComponent(ref.tag)}`);
    if (release === null || release === "unreachable") return release;
    const assets = Array.isArray(release.assets) ? (release.assets as Json[]) : [];
    const url = (name: string) => assets.find((entry) => entry.name === name)?.browser_download_url;
    const tarballUrl = url(tarballName);
    const sumsUrl = url("SHA256SUMS");
    if (typeof tarballUrl !== "string" || typeof sumsUrl !== "string") return null;
    for (const [from, to] of [[tarballUrl, tarballName], [sumsUrl, "SHA256SUMS"]] as const) {
      const ok = await download(from, join(dir, to));
      if (ok !== true) return ok;
    }
    return { tarball: join(dir, tarballName), sums: join(dir, "SHA256SUMS") };
  }
}

/** Streams a URL into a file, at most 300 MB, within 30 s to its first byte and 5 minutes in all. */
async function download(url: string, path: string): Promise<true | null | Unreachable> {
  const answer = await fetch(url, { headers: { "user-agent": "tyto-desk" }, redirect: "follow", signal: AbortSignal.timeout(5 * 60_000) }).catch(() => null);
  if (answer === null || answer.body === null) return "unreachable";
  if (!answer.ok) return answer.status === 404 ? null : "unreachable";
  let seen = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      done(seen > DOWNLOAD_MAX ? new Error("too large") : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(answer.body as Parameters<typeof Readable.fromWeb>[0]), limit, createWriteStream(path, { mode: 0o600 }));
    return true;
  } catch {
    return null;
  }
}
