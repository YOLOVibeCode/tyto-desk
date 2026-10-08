import { parseInstalled } from "../install/installed.ts";
import { installVersion, type InstallPorts } from "../install/install.ts";
import type { Archive } from "../ports/archive.ts";
import type { FileDigest } from "../ports/file-digest.ts";
import type { GhStatus, Provenance } from "../ports/provenance.ts";
import type { Random } from "../ports/random.ts";
import type { ReleaseFeed, ReleaseRef } from "../ports/release-feed.ts";
import type { TreeRemover } from "../ports/tree-remover.ts";
import { compareVersions, releaseTagVersion } from "../release/semver.ts";
import type { VersionInfo } from "../version/version-info.ts";

export type UpdatePorts = InstallPorts & { feed: ReleaseFeed; provenance: Provenance; digest: FileDigest; archive: Archive; random: Random; trees?: TreeRemover };

export type UpdateInput = {
  deskHome: string;
  home: string;
  platform: string;
  /** The runtime this Mac takes: `darwin-arm64` (or `linux-arm64` only in the test container). */
  asset: string;
  /** The version that runs this update. */
  current: VersionInfo;
  channel?: "stable" | "edge";
  version?: string;
  check?: boolean;
  now: string;
};

/** §23.5: 0 updated, already newest, or nothing newer · 65 a check failed · 69 gh · 75 GitHub unreachable · 77 declined. */
export type UpdateResult = { code: 0 | 64 | 65 | 69 | 75 | 77; message: string };

const GH_FIX: Readonly<Record<Exclude<GhStatus, { ok: true }>["reason"], string>> = {
  missing: "gh is not installed: brew install gh, then gh auth login",
  "signed-out": "gh is not signed in: gh auth login",
  old: "gh is older than 2.102.0, whose attestation checks Desk cannot rely on: brew upgrade gh",
};

/** `SHA256SUMS` as name → sha256; lines that are not `<64 hex>  <name>` are ignored. */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) sums.set(match[2], match[1]);
  }
  return sums;
}

function describe(ref: ReleaseRef): string {
  return ref.channel === "stable" ? `${ref.version} (${ref.tag})` : `${ref.version} (run ${ref.run ?? "?"})`;
}

/**
 * `desk update [--channel stable|edge] [--version X.Y.Z] [--check]` (docs/IMPLEMENTATION.md §23.5, slice D2b). In order,
 * and nothing is downloaded before the checks that need no download: gh 2.102.0 or later, signed in; the release tag is
 * exactly `vMAJOR.MINOR.PATCH`; the commit is on `main`; never backwards without `--version` (edge: only a run that sorts
 * after the current version); an installed version is never downloaded again. Then, before anything is extracted: the
 * tarball's sha256 against SHA256SUMS, `verify-asset` on both (a release), and provenance from the workflow on its exact
 * ref and commit. Then core's install, which checks that version.json names what was asked for and asks before it
 * switches; the daemon and `desk watch` are never stopped.
 */
export async function update(ports: UpdatePorts, input: UpdateInput): Promise<UpdateResult> {
  if (input.check === true) return check(ports, input);
  const channel = input.channel ?? (input.version !== undefined ? "stable" : input.current.channel);
  if (channel !== "stable" && channel !== "edge") {
    return {
      code: 65,
      message: `${input.current.version} is a ${input.current.channel} build: update it with npm run deploy from your checkout, or take releases with desk update --channel stable`,
    };
  }
  const gh = await ports.provenance.gh();
  if (!gh.ok) return { code: 69, message: GH_FIX[gh.reason] };

  const ref = channel === "edge" ? await ports.feed.latest("edge") : input.version !== undefined ? await ports.feed.find(input.version) : await ports.feed.latest("stable");
  if (ref === "unreachable") return { code: 75, message: "GitHub could not be reached; nothing changed" };
  if (ref === null) {
    const what = channel === "edge" ? "successful edge run on main with the artifact" : input.version !== undefined ? `release v${input.version}` : "stable release";
    return { code: input.version !== undefined ? 65 : 0, message: `There is no ${what}; nothing changed` };
  }
  if (ref.channel === "stable" && releaseTagVersion(ref.tag) !== ref.version) {
    return { code: 65, message: `the release tag ${ref.tag} is not exactly vMAJOR.MINOR.PATCH; nothing changed` };
  }
  const onMain = await ports.feed.onMain(ref.commit);
  if (onMain === "unreachable") return { code: 75, message: "GitHub could not be reached; nothing changed" };
  if (!onMain) return { code: 65, message: `${describe(ref)}'s commit ${ref.commit} is not on main; nothing changed` };

  const order = compareVersions(ref.version, input.current.version);
  if (ref.channel === "edge" && order <= 0) {
    return { code: 65, message: `edge ${describe(ref)} does not sort after the current version (${input.current.version}); nothing changed` };
  }
  if (ref.channel === "edge") {
    // A later run number is not enough: after main is rewound, a newer run can build older code (D55).
    const ahead = await ports.feed.ahead(input.current.commit, ref.commit);
    if (ahead === "unreachable") return { code: 75, message: "GitHub could not be reached; nothing changed" };
    if (!ahead) return { code: 65, message: `edge ${describe(ref)}'s commit ${ref.commit} is not after the current commit ${input.current.commit}; nothing changed` };
  }
  if (ref.channel === "stable" && input.version === undefined && order < 0) {
    return { code: 0, message: `releases/latest (${ref.tag}) is older than what you run (${input.current.version}); nothing changed` };
  }
  if (order === 0) return { code: 0, message: `${input.current.version} is the newest ${ref.channel === "edge" ? "edge build" : "release"}; nothing changed` };
  if ((await ports.versions.list()).includes(ref.version)) {
    // The installed copy must be this build, not another one under the same name (a directory install, another commit).
    const recorded = parseInstalled((await ports.files.read(`${input.deskHome.replace(/\/+$/, "")}/installed.json`)) ?? "")?.versions[ref.version];
    const same =
      typeof recorded === "object" && recorded !== null && (recorded as { commit?: unknown }).commit === ref.commit && (recorded as { channel?: unknown }).channel === ref.channel;
    if (!same) return { code: 65, message: `another build of Desk ${ref.version} is installed, not ${describe(ref)} at ${ref.commit}; nothing changed` };
    return { code: 0, message: `Desk ${ref.version} is installed already; desk use ${ref.version} makes it current` };
  }

  const dir = `${input.deskHome.replace(/\/+$/, "")}/downloads/${ports.random.id("d")}`;
  try {
    const fetched = await ports.feed.fetch(ref, input.asset, dir);
    if (fetched === "unreachable") return { code: 75, message: "GitHub could not be reached; nothing changed" };
    if (fetched === null) return { code: 65, message: `${describe(ref)} has no ${input.asset} runtime and SHA256SUMS; nothing changed` };
    const expected = parseSha256Sums((await ports.files.read(fetched.sums)) ?? "").get(`desk-${ref.version}-${input.asset}.tar.gz`);
    const actual = await ports.digest.sha256(fetched.tarball);
    if (expected === undefined || actual !== expected) return { code: 65, message: `the download's sha256 does not match SHA256SUMS; nothing was installed` };
    if (ref.channel === "stable" && !((await ports.provenance.verifyAsset(ref.tag, fetched.tarball)) && (await ports.provenance.verifyAsset(ref.tag, fetched.sums)))) {
      return { code: 65, message: `gh release verify-asset refused the download of ${ref.tag}; nothing was installed` };
    }
    const workflow = ref.channel === "stable" ? "release.yml" : "edge.yml";
    const sourceRef = ref.channel === "stable" ? `refs/tags/${ref.tag}` : "refs/heads/main";
    if (!(await ports.provenance.attest(fetched.tarball, { workflow, ref: sourceRef, commit: ref.commit }))) {
      return { code: 65, message: `the download's provenance does not name ${workflow} on ${sourceRef} at ${ref.commit}; nothing was installed` };
    }
    const runtime = await ports.archive.extract(fetched.tarball, `${dir}/runtime`);
    if (runtime === null) return { code: 65, message: "the download could not be extracted; nothing was installed" };
    const installed = await installVersion(ports, {
      from: runtime,
      deskHome: input.deskHome,
      home: input.home,
      platform: input.platform,
      provenance: `${workflow}@${sourceRef}`,
      now: input.now,
      expected: { version: ref.version, channel: ref.channel, commit: ref.commit },
      downgrade: order < 0,
    });
    if (!installed.ok) return { code: installed.code, message: installed.message };
    return { code: 0, message: `Updated to ${ref.version}; run desk` };
  } finally {
    await ports.trees?.remove(dir);
  }
}

/** `--check`: the current version and the newest per channel; nothing changes, and nothing is downloaded. */
async function check(ports: UpdatePorts, input: UpdateInput): Promise<UpdateResult> {
  const lines = [`current: ${input.current.version} (${input.current.channel})`];
  for (const channel of ["stable", "edge"] as const) {
    const ref = await ports.feed.latest(channel);
    lines.push(`${channel}: ${ref === "unreachable" ? "GitHub could not be reached" : ref === null ? "none" : describe(ref)}`);
  }
  return { code: 0, message: lines.join("\n") };
}
