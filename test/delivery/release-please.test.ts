import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RELEASE_BRANCH } from "../../scripts/delivery/lib/release-branch.mjs";
import { repo } from "./helpers.ts";

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(repo, path), "utf8")) as Record<string, unknown>;
}

const config = await json("release-please-config.json");
const sections = config["changelog-sections"] as { type: string; section: string; hidden?: boolean }[];
const packages = config.packages as Record<string, Record<string, unknown>>;

/** The release-please-action that release-please.yml pins; it bundles release-please 17.6.0, whose branch rule is below. */
const RELEASE_PLEASE_ACTION = "googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7 # v5.0.0";

/**
 * The release PR's head branch as release-please 17.6.0 names it (src/manifest.ts, src/strategies/base.ts): one package
 * means separate pull requests unless the config says otherwise, and a separate pull request's branch carries the
 * package's component, its package name without an npm scope. `include-component-in-tag: false` changes only the tag.
 * A merged pull request (`separate-pull-requests: false`) is named after the target branch alone.
 */
function releasePleaseBranch(target: string): string {
  const only = packages["."] ?? {};
  const component = String(only.component ?? only["package-name"] ?? "").replace(/^@[\w-]+\//, "");
  const separate = config["separate-pull-requests"] ?? Object.keys(packages).length === 1;
  return separate === false || component === ""
    ? `release-please--branches--${target}`
    : `release-please--branches--${target}--components--${component}`;
}

describe("the release-please config", () => {
  it("the release-please config opens the release PR as a draft labeled live", () => {
    expect(config["draft-pull-request"]).toBe(true);
    expect(config["extra-label"]).toBe("live");
    expect(config["pull-request-header"]).toContain("never merges itself");
  });

  it("the release-please config tags vX.Y.Z, drafts each release with its tag, starts at 0.1.0 with feat bumping the patch before 1.0, and hides docs, test, build, ci and chore", () => {
    expect(config["include-component-in-tag"]).toBe(false);
    expect(config["include-v-in-tag"] ?? true).toBe(true);
    expect(config.draft).toBe(true);
    expect(config["force-tag-creation"]).toBe(true);
    expect(config.prerelease).toBe(false);
    expect(config["initial-version"]).toBe("0.1.0");
    expect(config["bump-minor-pre-major"]).toBe(true);
    expect(config["bump-patch-for-minor-pre-major"]).toBe(true);
    expect(sections.filter((s) => s.hidden === true).map((s) => s.type).sort()).toEqual(["build", "chore", "ci", "docs", "test"]);
    expect(sections.filter((s) => s.hidden !== true).map((s) => s.type)).toEqual(["feat", "fix", "perf", "refactor", "revert"]);
  });

  it("the release-please config bumps only the root package.json and package-lock.json", async () => {
    const root = await json("package.json");
    const lock = await json("package-lock.json");
    const lockPackages = lock.packages as Record<string, { version?: string }>;

    expect(config["release-type"]).toBe("node");
    expect(Object.keys(packages)).toEqual(["."]);
    expect(packages["."]).toEqual({ "package-name": "tyto-desk", "changelog-path": "CHANGELOG.md" });
    for (const key of ["plugins", "extra-files", "separate-pull-requests", "versioning"]) expect(config[key]).toBeUndefined();
    expect(await json(".release-please-manifest.json")).toEqual({});
    expect([root.version, lock.version, lockPackages[""]?.version]).toEqual(["0.0.0", "0.0.0", "0.0.0"]);
    for (const workspace of ["packages/core", "packages/node"]) {
      expect(await json(`${workspace}/package.json`)).toMatchObject({ version: "0.1.0", private: true });
    }
  });

  it("the release PR's branch, which ci-ok, the PR check and owner-merge name, is the one release-please names from this config", async () => {
    const workflow = await readFile(join(repo, ".github/workflows/release-please.yml"), "utf8");
    const ownerPaths = await json("scripts/delivery/owner-paths.json");

    // Another release-please-action may name the branch another way: read its source and update releasePleaseBranch.
    expect(workflow).toContain(`uses: ${RELEASE_PLEASE_ACTION}`);
    expect(RELEASE_BRANCH).toBe(releasePleaseBranch("main"));
    expect(RELEASE_BRANCH).toBe("release-please--branches--main--components--tyto-desk");
    expect(ownerPaths.branches).toEqual([RELEASE_BRANCH]);
  });
});
