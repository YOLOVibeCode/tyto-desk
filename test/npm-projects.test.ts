import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { automergeDecision } from "../scripts/delivery/lib/automerge-decision.mjs";
import { checkTitleAndBranch } from "../scripts/delivery/lib/pr-check.mjs";
import { OTHER_LOCKFILE_DIRS, separateNpmProjectsIn } from "../scripts/lib/install-scripts.mjs";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("..", import.meta.url));
const TOOLS = "test/live/image/tools";

/** Every npm project in the repo: the root, and each one of its own (lint:install-scripts keeps that list whole). */
const PROJECTS = [".", ...OTHER_LOCKFILE_DIRS];

type Step = { run?: string; "working-directory"?: string };
type Update = { "package-ecosystem"?: string; directory?: string; "commit-message"?: { prefix?: string; include?: string } };

/**
 * `npm config get <key>` in a directory of the checkout, as npm resolves it there from the project's own .npmrc alone:
 * no user or global config, none of the npm_config_* variables `npm test` runs with, and offline.
 */
async function npmConfig(dir: string, key: string): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "npm-config-"));
  const [user, global] = [join(scratch, "user-npmrc"), join(scratch, "global-npmrc")];
  await writeFile(user, "");
  await writeFile(global, "");
  const { stdout } = await run("npm", ["config", "get", key], {
    cwd: join(repo, dir),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: scratch,
      npm_config_userconfig: user,
      npm_config_globalconfig: global,
      npm_config_cache: join(scratch, "cache"),
      npm_config_offline: "true",
      npm_config_update_notifier: "false",
    },
    timeout: 30_000,
  });
  return stdout.trim();
}

async function dependabotUpdates(): Promise<Update[]> {
  const config = parse(await readFile(`${repo}.github/dependabot.yml`, "utf8")) as { updates?: Update[] };
  return config.updates ?? [];
}

describe("the repo's npm projects", () => {
  it("every npm project of its own in the repo is one whose lockfile lint:install-scripts reads", async () => {
    expect(await separateNpmProjectsIn(repo)).toEqual(OTHER_LOCKFILE_DIRS);
  });

  it.each(PROJECTS)(
    "npm runs every npm project in the repo with install scripts off and exact pins, from its own .npmrc (%s)",
    async (dir) => {
      expect(await npmConfig(dir, "ignore-scripts")).toBe("true");
      expect(await npmConfig(dir, "save-exact")).toBe("true");
    },
  );

  it.each(PROJECTS)(
    "CI checks the registry signatures of every npm project in the repo, after npm ci --ignore-scripts there (%s)",
    async (dir) => {
      const ci = parse(await readFile(`${repo}.github/workflows/ci.yml`, "utf8")) as { jobs: { check: { steps: Step[] } } };
      const here = ci.jobs.check.steps.filter((step) => (step["working-directory"] ?? ".") === dir);
      const install = here.findIndex((step) => step.run === "npm ci --ignore-scripts");
      const audit = here.findIndex((step) => step.run === "npm audit signatures");

      expect(install).toBeGreaterThan(-1);
      expect(audit).toBeGreaterThan(install);
    },
  );

  it("Dependabot's npm updater watches every npm project in the repo", async () => {
    const npm = (await dependabotUpdates()).filter((update) => update["package-ecosystem"] === "npm");

    expect(npm.map((update) => update.directory).sort()).toEqual(PROJECTS.map((dir) => (dir === "." ? "/" : `/${dir}`)).sort());
  });

  it("no update Dependabot opens for the live image's tools merges itself", async () => {
    const manifest = JSON.parse(await readFile(`${repo}${TOOLS}/package.json`, "utf8")) as Record<string, unknown>;
    const types = {
      dependencies: "direct:production",
      optionalDependencies: "direct:production",
      devDependencies: "direct:development",
    };
    const updates = Object.entries(types).flatMap(([field, dependencyType]) =>
      Object.keys((manifest[field] ?? {}) as Record<string, string>).map((dependencyName) => ({
        dependencyName,
        dependencyType,
        updateType: "version-update:semver-patch",
        directory: `/${TOOLS}`,
        packageEcosystem: "npm_and_yarn",
        targetBranch: "main",
      })),
    );

    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) expect(automergeDecision([update], { checksRequired: true })).toMatchObject({ merge: false });
  });

  it("Dependabot titles the live image's tools' pull requests so that pr-title passes them", async () => {
    const entry = (await dependabotUpdates()).find(
      (update) => update["package-ecosystem"] === "npm" && update.directory === `/${TOOLS}`,
    );
    const title = `${entry?.["commit-message"]?.prefix ?? "none"}(deps): bump agent-browser from 0.38.1 to 0.39.0 in /${TOOLS}`;

    expect(entry?.["commit-message"]?.include).toBe("scope");
    expect(checkTitleAndBranch({ title, branch: `dependabot/npm_and_yarn/${TOOLS}/agent-browser-0.39.0`, fork: false })).toEqual([]);
  });
});
