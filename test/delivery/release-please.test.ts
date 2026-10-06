import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repo } from "./helpers.ts";

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(repo, path), "utf8")) as Record<string, unknown>;
}

const config = await json("release-please-config.json");
const sections = config["changelog-sections"] as { type: string; section: string; hidden?: boolean }[];
const packages = config.packages as Record<string, Record<string, unknown>>;

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
});
