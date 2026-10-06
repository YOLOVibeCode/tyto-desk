import { branchSlug } from "./branch-slug.ts";
import { isBaseVersion, releaseTagVersion } from "./semver.ts";

/** What a build is (docs/IMPLEMENTATION.md §23.3). */
export type BuildChannel = "stable" | "edge" | "pr" | "dev";

/**
 * Where a build goes: `release` is the tag's draft release, published after the owner approves; `attested-artifact` is
 * an attested workflow artifact (edge); `none` publishes nothing (pull requests, dry runs, dev builds).
 */
export type BuildPublish = "release" | "attested-artifact" | "none";

/** Whether the live suite runs: before publishing (`gate`), on the `live` label (`on-label`), or not at all. */
export type LiveSuite = "gate" | "on-label" | "off";

/** Why a build stops before anything is published or installed, in the order of §23.3's table. */
export type BuildRefusal =
  | "tag-not-semver"
  | "tag-not-on-main"
  | "version-mismatch"
  | "bad-base-version"
  | "dirty-tree"
  | "allow-dirty-in-ci"
  | "unsupported-ref"
  | "no-commit";

const REFUSAL_ORDER: readonly BuildRefusal[] = [
  "tag-not-semver",
  "tag-not-on-main",
  "version-mismatch",
  "bad-base-version",
  "dirty-tree",
  "allow-dirty-in-ci",
  "unsupported-ref",
  "no-commit",
];

/** The facts the stamp gathers (`scripts/delivery/stamp.mjs`, §23.3). */
export type ClassifyBuildInput = {
  /** `GITHUB_EVENT_NAME` in CI; `local` for a checkout. */
  readonly event: string;
  /** `GITHUB_REF` (`refs/tags/v0.3.0`, `refs/heads/main`, `refs/pull/42/merge`); unused for `local`. */
  readonly ref: string;
  /** `GITHUB_REF_TYPE`; `null` for `local`. */
  readonly refType: "tag" | "branch" | null;
  /** The checked-out branch locally; `main` for a tag on main; the head branch of a pull request. */
  readonly branch: string | null;
  /** Whether the tagged commit is an ancestor of `main`; false when the stamp could not tell. */
  readonly tagOnMain: boolean;
  /** The commit being built (for a pull request, its head), or `null` outside a git checkout. */
  readonly sha: string | null;
  readonly dirty: boolean;
  readonly allowDirty: boolean;
  /** `release.yml` dispatched on `main`: rehearse a release without publishing anything. */
  readonly dryRun: boolean;
  readonly headRepoIsFork: boolean;
  /** The root package.json's `version`. */
  readonly baseVersion: string;
  readonly prNumber: number | null;
  /** `GITHUB_RUN_NUMBER`; `null` for `local`. */
  readonly runNumber: number | null;
  /** UTC, ISO 8601 (`2026-10-06T18:00:00Z`); a dirty dev build carries it in its version. */
  readonly builtAt: string;
};

export type BuildClassification =
  | {
      readonly ok: true;
      readonly channel: BuildChannel;
      readonly version: string;
      /** The version as people write it: `v0.3.0`. */
      readonly label: string;
      readonly publish: BuildPublish;
      readonly live: LiveSuite;
      readonly refusals: readonly [];
    }
  | { readonly ok: false; readonly refusals: readonly BuildRefusal[] };

type BuildKind = "tag" | "dry-run" | "edge" | "pr" | "dev";

const MAIN = "refs/heads/main";
const TAGS = "refs/tags/";
const EDGE_EVENTS = new Set(["push", "workflow_dispatch", "schedule"]);
const TAG_EVENTS = new Set(["push", "workflow_dispatch"]);

/** Which build `input` asks for, or `null` for a ref or event Desk never builds from. */
function buildKind(input: ClassifyBuildInput): BuildKind | null {
  const { event, ref, refType, dryRun } = input;
  if (event === "local") return "dev";
  if (ref.startsWith(TAGS)) return refType === "tag" && TAG_EVENTS.has(event) && !dryRun ? "tag" : null;
  if (refType === "tag") return null;
  if (event === "pull_request") return dryRun ? null : "pr";
  if (ref !== MAIN) return null;
  if (dryRun) return event === "workflow_dispatch" ? "dry-run" : null;
  return EDGE_EVENTS.has(event) ? "edge" : null;
}

function positiveInteger(value: number | null, name: string): number {
  if (value === null || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`classifyBuild needs a positive integer ${name} for this build`);
  }
  return value;
}

/** `2026-10-06T18:00:00Z` → `20261006t180000z`: a valid SemVer build identifier, one per second. */
function buildTimeId(builtAt: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(builtAt);
  if (match === null) throw new Error("classifyBuild needs builtAt as UTC ISO 8601, such as 2026-10-06T18:00:00Z");
  const [, year, month, day, hour, minute, second] = match;
  return `${year}${month}${day}t${hour}${minute}${second}z`;
}

function nextPatch(base: string): string {
  const [major, minor, patch] = base.split(".").map(Number);
  return `${major}.${minor}.${(patch ?? 0) + 1}`;
}

/**
 * Decides what a build is: its channel, version, where it is published, and whether the live suite gates it
 * (docs/IMPLEMENTATION.md §23.3). Any refusal stops the build before anything is published or installed.
 */
export function classifyBuild(input: ClassifyBuildInput): BuildClassification {
  const refusals = new Set<BuildRefusal>();
  const ci = input.event !== "local";
  const kind = buildKind(input);
  if (kind === "tag") {
    const tagVersion = releaseTagVersion(input.ref.slice(TAGS.length));
    if (tagVersion === null) refusals.add("tag-not-semver");
    if (!input.tagOnMain) refusals.add("tag-not-on-main");
    if (tagVersion !== null && isBaseVersion(input.baseVersion) && tagVersion !== input.baseVersion) {
      refusals.add("version-mismatch");
    }
  }
  if (!isBaseVersion(input.baseVersion)) refusals.add("bad-base-version");
  if (input.dirty && (ci || !input.allowDirty)) refusals.add("dirty-tree");
  if (ci && input.allowDirty) refusals.add("allow-dirty-in-ci");
  if (kind === null) refusals.add("unsupported-ref");
  if (input.sha === null || !/^[0-9a-f]{40}$/.test(input.sha)) refusals.add("no-commit");
  if (refusals.size > 0 || kind === null || input.sha === null) {
    return { ok: false, refusals: REFUSAL_ORDER.filter((refusal) => refusals.has(refusal)) };
  }

  const base = input.baseVersion;
  const sha7 = input.sha.slice(0, 7);
  const build = (channel: BuildChannel, version: string, publish: BuildPublish, live: LiveSuite) =>
    ({ ok: true, channel, version, label: `v${version}`, publish, live, refusals: [] }) as const;
  switch (kind) {
    case "tag":
      return build("stable", base, "release", "gate");
    case "dry-run":
      return build("stable", `${base}+dryrun.${positiveInteger(input.runNumber, "run number")}`, "none", "gate");
    case "edge":
      return build(
        "edge",
        `${nextPatch(base)}-edge.${positiveInteger(input.runNumber, "run number")}+${sha7}`,
        "attested-artifact",
        "off",
      );
    case "pr": {
      const number = positiveInteger(input.prNumber, "pull request number");
      const run = positiveInteger(input.runNumber, "run number");
      return build(
        "pr",
        `${nextPatch(base)}-pr.${number}.${run}+${sha7}`,
        "none",
        input.headRepoIsFork ? "off" : "on-label",
      );
    }
    case "dev": {
      const dirty = input.dirty ? `.dirty.${buildTimeId(input.builtAt)}` : "";
      return build("dev", `${nextPatch(base)}-dev.${branchSlug(input.branch)}+${sha7}${dirty}`, "none", "off");
    }
    default: {
      const never: never = kind;
      throw new Error(`unknown build kind ${String(never)}`);
    }
  }
}
