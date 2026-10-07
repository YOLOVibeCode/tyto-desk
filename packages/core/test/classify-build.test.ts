import { describe, expect, it } from "vitest";
import { branchSlug, classifyBuild, compareVersions, type ClassifyBuildInput } from "../src/index.ts";

const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

/** The §23.3 example: a push of v0.3.0, a tag on main whose version matches package.json. */
const tag: ClassifyBuildInput = {
  event: "push",
  ref: "refs/tags/v0.3.0",
  refType: "tag",
  branch: "main",
  tagOnMain: true,
  sha,
  dirty: false,
  allowDirty: false,
  dryRun: false,
  headRepoIsFork: false,
  baseVersion: "0.3.0",
  prNumber: null,
  runNumber: 57,
  builtAt: "2026-10-06T18:00:00Z",
};
const main: ClassifyBuildInput = { ...tag, ref: "refs/heads/main", refType: "branch", tagOnMain: false };
const pr: ClassifyBuildInput = {
  ...main,
  event: "pull_request",
  ref: "refs/pull/42/merge",
  branch: "slice-1c/walking-skeleton",
  prNumber: 42,
  runNumber: 118,
};
const local: ClassifyBuildInput = {
  ...main,
  event: "local",
  ref: "refs/heads/slice-1c/walking-skeleton",
  branch: "slice-1c/walking-skeleton",
  runNumber: null,
};
const dryRun: ClassifyBuildInput = { ...main, event: "workflow_dispatch", dryRun: true, runNumber: 12 };

function decision(input: ClassifyBuildInput): string {
  const result = classifyBuild(input);
  return result.ok ? result.channel : result.refusals.join(",");
}

function versionOf(input: ClassifyBuildInput): string {
  const result = classifyBuild(input);
  if (!result.ok) throw new Error(`refused: ${result.refusals.join(", ")}`);
  return result.version;
}

describe("classifyBuild", () => {
  it("classifyBuild makes a v-tag on main whose version matches package.json a stable build", () => {
    expect(classifyBuild(tag)).toEqual({
      ok: true,
      channel: "stable",
      version: "0.3.0",
      label: "v0.3.0",
      publish: "release",
      live: "gate",
      refusals: [],
    });
  });

  it.each([
    { decision: "stable", event: "push", on: "a v-tag", input: tag },
    { decision: "stable", event: "workflow_dispatch", on: "a v-tag", input: { ...tag, event: "workflow_dispatch" } },
    { decision: "edge", event: "push", on: "main", input: main },
    { decision: "edge", event: "workflow_dispatch", on: "main", input: { ...main, event: "workflow_dispatch" } },
    { decision: "edge", event: "schedule", on: "main", input: { ...main, event: "schedule" } },
    { decision: "pr", event: "pull_request from this repository", on: "refs/pull/42/merge", input: pr },
    { decision: "pr", event: "pull_request from a fork", on: "refs/pull/42/merge", input: { ...pr, headRepoIsFork: true } },
    {
      decision: "unsupported-ref",
      event: "workflow_dispatch",
      on: "another branch",
      input: { ...main, event: "workflow_dispatch", ref: "refs/heads/feat/x" },
    },
  ])("classifyBuild decides $decision for $event on $on", ({ decision: expected, input }) => {
    expect(decision(input)).toBe(expected);
  });

  it("classifyBuild makes a release dry run on main a stable-shaped build that publishes nothing", () => {
    expect(classifyBuild(dryRun)).toEqual({
      ok: true,
      channel: "stable",
      version: "0.3.0+dryrun.12",
      label: "v0.3.0+dryrun.12",
      publish: "none",
      live: "gate",
      refusals: [],
    });
  });

  it("classifyBuild refuses a tag that is not on main", () => {
    expect(classifyBuild({ ...tag, tagOnMain: false, branch: null })).toEqual({ ok: false, refusals: ["tag-not-on-main"] });
  });

  it("classifyBuild refuses a tag whose version differs from package.json", () => {
    expect(classifyBuild({ ...tag, baseVersion: "0.2.9" })).toEqual({ ok: false, refusals: ["version-mismatch"] });
  });

  it.each(["v1.2", "1.2.3", "v1.2.3-rc.1", "v01.2.3", "V1.2.3"])(
    "classifyBuild refuses %s as not vMAJOR.MINOR.PATCH",
    (name) => {
      expect(classifyBuild({ ...tag, ref: `refs/tags/${name}`, baseVersion: "1.2.3" })).toEqual({
        ok: false,
        refusals: ["tag-not-semver"],
      });
    },
  );

  it.each(["0.3", "0.3.0-rc.1", "0.3.0+build.1", "v0.3.0", "00.3.0", ""])(
    "classifyBuild refuses a base version that is not MAJOR.MINOR.PATCH (%j)",
    (baseVersion) => {
      expect(classifyBuild({ ...main, baseVersion })).toEqual({ ok: false, refusals: ["bad-base-version"] });
    },
  );

  it.each([null, "a1b2c3d", `${sha}0`, sha.toUpperCase()])("classifyBuild refuses a tree with no 40-hex commit (%j)", (commit) => {
    expect(classifyBuild({ ...main, sha: commit })).toEqual({ ok: false, refusals: ["no-commit"] });
  });

  it("classifyBuild makes a push to main an edge build of the next patch with its run number and short commit", () => {
    expect(classifyBuild(main)).toEqual({
      ok: true,
      channel: "edge",
      version: "0.3.1-edge.57+a1b2c3d",
      label: "v0.3.1-edge.57+a1b2c3d",
      publish: "attested-artifact",
      live: "off",
      refusals: [],
    });
  });

  it("classifyBuild makes a pull request a pr build of its head commit that is never published", () => {
    expect(classifyBuild(pr)).toEqual({
      ok: true,
      channel: "pr",
      version: "0.3.1-pr.42.118+a1b2c3d",
      label: "v0.3.1-pr.42.118+a1b2c3d",
      publish: "none",
      live: "on-label",
      refusals: [],
    });
  });

  it("classifyBuild makes a local checkout a dev build named after its branch", () => {
    expect(classifyBuild(local)).toEqual({
      ok: true,
      channel: "dev",
      version: "0.3.1-dev.slice-1c-walking-skeleton+a1b2c3d",
      label: "v0.3.1-dev.slice-1c-walking-skeleton+a1b2c3d",
      publish: "none",
      live: "off",
      refusals: [],
    });
    expect(versionOf({ ...local, branch: null })).toBe("0.3.1-dev.detached+a1b2c3d");
  });

  it("classifyBuild refuses a dirty tree unless allowDirty, and versions an allowed one .dirty with its build time", () => {
    expect(classifyBuild({ ...local, dirty: true })).toEqual({ ok: false, refusals: ["dirty-tree"] });
    expect(classifyBuild({ ...main, dirty: true })).toEqual({ ok: false, refusals: ["dirty-tree"] });
    expect(versionOf({ ...local, dirty: true, allowDirty: true })).toBe(
      "0.3.1-dev.slice-1c-walking-skeleton+a1b2c3d.dirty.20261006t180000z",
    );
    expect(versionOf({ ...local, dirty: true, allowDirty: true, builtAt: "2026-10-06T18:00:01.250Z" })).toBe(
      "0.3.1-dev.slice-1c-walking-skeleton+a1b2c3d.dirty.20261006t180001z",
    );
    expect(versionOf({ ...local, allowDirty: true })).toBe("0.3.1-dev.slice-1c-walking-skeleton+a1b2c3d");
  });

  it.each<{ label: string; input: ClassifyBuildInput; refusals: string[] }>([
    { label: "allowDirty on main", input: { ...main, allowDirty: true }, refusals: ["allow-dirty-in-ci"] },
    { label: "allowDirty on a dirty main", input: { ...main, allowDirty: true, dirty: true }, refusals: ["dirty-tree", "allow-dirty-in-ci"] },
    { label: "a push to another branch", input: { ...main, ref: "refs/heads/feat/x" }, refusals: ["unsupported-ref"] },
    { label: "a schedule on another branch", input: { ...main, event: "schedule", ref: "refs/heads/release" }, refusals: ["unsupported-ref"] },
    { label: "pull_request_target", input: { ...main, event: "pull_request_target", ref: "refs/heads/main" }, refusals: ["unsupported-ref"] },
    { label: "workflow_call", input: { ...main, event: "workflow_call" }, refusals: ["unsupported-ref"] },
    { label: "main called a tag", input: { ...main, refType: "tag" }, refusals: ["unsupported-ref"] },
    { label: "a tag called a branch", input: { ...tag, refType: "branch" }, refusals: ["unsupported-ref"] },
    { label: "a schedule on a tag", input: { ...tag, event: "schedule" }, refusals: ["unsupported-ref"] },
    { label: "a dry run of a tag", input: { ...tag, dryRun: true }, refusals: ["unsupported-ref"] },
    { label: "a dry run on a push", input: { ...dryRun, event: "push" }, refusals: ["unsupported-ref"] },
    { label: "a dry run of a pull request", input: { ...pr, dryRun: true }, refusals: ["unsupported-ref"] },
  ])("classifyBuild refuses allowDirty, and any ref but main, a v-tag or a pull request, in CI ($label)", ({ input, refusals }) => {
    expect(classifyBuild(input)).toEqual({ ok: false, refusals });
  });

  it("classifyBuild gates stable builds on the live suite, runs it for same-repository pr builds on the live label, and never for forks, edge or dev", () => {
    const live = (input: ClassifyBuildInput) => {
      const result = classifyBuild(input);
      return result.ok ? result.live : null;
    };

    expect(live(tag)).toBe("gate");
    expect(live(dryRun)).toBe("gate");
    expect(live(pr)).toBe("on-label");
    expect(live({ ...pr, headRepoIsFork: true })).toBe("off");
    expect(live(main)).toBe("off");
    expect(live(local)).toBe("off");
  });

  it("classifyBuild names every refusal that applies, in the order of IMPLEMENTATION §23.3", () => {
    expect(
      classifyBuild({ ...tag, ref: "refs/tags/v1.2", tagOnMain: false, baseVersion: "1.2", dirty: true, sha: null }),
    ).toEqual({ ok: false, refusals: ["tag-not-semver", "tag-not-on-main", "bad-base-version", "dirty-tree", "no-commit"] });
  });
});

describe("branchSlug", () => {
  it.each([
    { name: "slice-1c/walking-skeleton", branch: "slice-1c/walking-skeleton", slug: "slice-1c-walking-skeleton" },
    { name: "Fix/ÜBER_wide", branch: "Fix/ÜBER_wide", slug: "fix-ber-wide" },
    { name: "an empty name", branch: "", slug: "detached" },
    { name: "007", branch: "007", slug: "b007" },
    { name: "a detached HEAD", branch: null, slug: "detached" },
    { name: "only separators", branch: "--/__/--", slug: "detached" },
    { name: "a name longer than 40 characters", branch: `feat/${"x".repeat(60)}`, slug: `feat-${"x".repeat(35)}` },
    { name: "a cut that ends in a separator", branch: `${"y".repeat(39)}/z`, slug: "y".repeat(39) },
  ])("branchSlug turns $name into $slug", ({ branch, slug }) => {
    expect(branchSlug(branch)).toBe(slug);
  });
});

describe("versions", () => {
  it("a prerelease classifyBuild returns sorts after its base version and before the next patch, and a stable version equals its base", () => {
    const prereleases = [
      versionOf(main),
      versionOf(pr),
      versionOf(local),
      versionOf({ ...local, dirty: true, allowDirty: true }),
      versionOf({ ...local, branch: "007" }),
    ];
    for (const version of prereleases) {
      expect(compareVersions(version, "0.3.0")).toBe(1);
      expect(compareVersions(version, "0.3.1")).toBe(-1);
    }
    expect(versionOf(tag)).toBe("0.3.0");
    expect(compareVersions(versionOf(tag), tag.baseVersion)).toBe(0);
    expect(compareVersions(versionOf(dryRun), dryRun.baseVersion)).toBe(0);
  });

  it.each([
    ["1.0.0-alpha", "1.0.0-alpha.1"],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta"],
    ["1.0.0-alpha.beta", "1.0.0-beta"],
    ["1.0.0-beta", "1.0.0-beta.2"],
    ["1.0.0-beta.2", "1.0.0-beta.11"],
    ["1.0.0-beta.11", "1.0.0-rc.1"],
    ["1.0.0-rc.1", "1.0.0"],
    ["0.3.1-edge.57+a1b2c3d", "0.3.1-edge.58+0000000"],
    ["0.9.9", "0.10.0"],
  ])("compareVersions sorts %s before %s, as SemVer 2.0.0 does", (lower, higher) => {
    expect(compareVersions(lower, higher)).toBe(-1);
    expect(compareVersions(higher, lower)).toBe(1);
  });

  it("compareVersions ignores build metadata", () => {
    expect(compareVersions("0.3.0+dryrun.12", "0.3.0")).toBe(0);
  });

  it.each(["v0.3.0", "0.3", "01.2.3", "1.2.3-01", "1.2.3-", "1.2.3+", "1.2.3-a..b"])(
    "compareVersions refuses %s as not SemVer",
    (bad) => {
      expect(() => compareVersions(bad, "0.3.0")).toThrow(/not a SemVer version/);
    },
  );
});
