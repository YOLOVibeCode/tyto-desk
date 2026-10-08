import type { GhInstalled, GhStatus, GhVersion, Provenance } from "@desk/core";
import { runArgv } from "@desk/node";

/** The repository releases come from. */
export const DESK_REPO = "YOLOVibeCode/tyto-desk";

/** The oldest `gh` whose attestation checks Desk relies on (§23.5): older ones matched identities loosely. */
const GH_MIN = [2, 102, 0] as const;

/**
 * Provenance through `gh` argv (docs/IMPLEMENTATION.md §23.5): its version and sign-in, `release verify-asset`, and
 * `attestation verify` with the workflow and ref as an exact certificate identity, the commit as the source digest, and
 * no self-hosted runners. 60 s each.
 */
export class GhProvenance implements Provenance, GhVersion {
  private readonly binary: string;
  private readonly repo: string;
  private readonly env: Record<string, string>;

  constructor(input: { gh: string; repo: string; env: Readonly<Record<string, string | undefined>> }) {
    this.binary = input.gh;
    this.repo = input.repo;
    this.env = {};
    for (const name of ["HOME", "PATH", "USER", "TMPDIR", "LANG", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"]) {
      const value = input.env[name];
      if (value !== undefined) this.env[name] = value;
    }
  }

  private run(args: readonly string[]) {
    return runArgv(this.binary, args, { env: this.env, timeoutMs: 60_000, maxBytes: 1024 * 1024, cwd: "/" });
  }

  async installed(): Promise<GhInstalled> {
    const version = await this.run(["--version"]).catch(() => null);
    if (version === null || version.code === 127 || version.code === -2 || version.stdout === "") return { ok: false, reason: "missing" };
    const match = /gh version (\d+)\.(\d+)\.(\d+)/.exec(version.stdout);
    if (match === null) return { ok: false, reason: "missing" };
    const have = [Number(match[1]), Number(match[2]), Number(match[3])];
    const older = have[0]! < GH_MIN[0] || (have[0] === GH_MIN[0] && (have[1]! < GH_MIN[1] || (have[1] === GH_MIN[1] && have[2]! < GH_MIN[2])));
    return older ? { ok: false, reason: "old" } : { ok: true };
  }

  async gh(): Promise<GhStatus> {
    const installed = await this.installed();
    if (!installed.ok) return installed;
    return (await this.run(["auth", "status"])).code === 0 ? { ok: true } : { ok: false, reason: "signed-out" };
  }

  async verifyAsset(tag: string, file: string): Promise<boolean> {
    return (await this.run(["release", "verify-asset", tag, file, "--repo", this.repo])).code === 0;
  }

  async attest(file: string, input: { workflow: "release.yml" | "edge.yml"; ref: string; commit: string }): Promise<boolean> {
    if (!/^[0-9a-f]{40}$/.test(input.commit) || !/^refs\/(tags\/v\d+\.\d+\.\d+|heads\/main)$/.test(input.ref)) return false;
    const identity = `https://github.com/${this.repo}/.github/workflows/${input.workflow}@${input.ref}`;
    const result = await this.run([
      "attestation",
      "verify",
      file,
      "--repo",
      this.repo,
      "--cert-identity",
      identity,
      "--source-ref",
      input.ref,
      "--source-digest",
      input.commit,
      "--deny-self-hosted-runners",
    ]);
    return result.code === 0;
  }
}
