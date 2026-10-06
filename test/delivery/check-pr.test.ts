import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkTitleAndBranch, checkWorkflowFiles, ghPullRequestSource } from "../../scripts/delivery/lib/pr-check.mjs";
import { fakeGh, notFound, ok } from "./fake-gh.ts";
import { repo, runScript } from "./helpers.ts";

const checkPr = join(repo, "scripts/delivery/check-pr.mjs");
const HEAD = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const REPOSITORY = "YOLOVibeCode/tyto-desk";

const sameRepo = (title: string, branch: string) => checkTitleAndBranch({ title, branch, fork: false });

/** A workflow that keeps every rule of §23.7. */
function workflow(jobId = "build", runsOn = "ubuntu-24.04"): string {
  return [
    "name: x",
    "on:",
    "  push:",
    "permissions: {}",
    "jobs:",
    `  ${jobId}:`,
    `    runs-on: ${runsOn}`,
    "    timeout-minutes: 5",
    "    permissions:",
    "      contents: read",
    "    steps:",
    `      - uses: actions/checkout@${CHECKOUT_SHA} # v7.0.1`,
    "        with:",
    "          persist-credentials: false",
    "",
  ].join("\n");
}

/** The REST API as gh sees it: the PR head's workflow files, and the commit each action tag names. */
function github(files: Record<string, string>, tags: Record<string, string | null> = { "actions/checkout@v7.0.1": CHECKOUT_SHA }) {
  return fakeGh([
    {
      match: new RegExp(`^api --method GET repos/${REPOSITORY}/contents/\\.github/workflows\\?ref=${HEAD}$`),
      reply: () =>
        ok(Object.keys(files).map((name) => ({ name, path: `.github/workflows/${name}`, type: "file" }))),
    },
    {
      match: new RegExp(`^api --method GET -H Accept: application/vnd\\.github\\.raw repos/${REPOSITORY}/contents/\\.github/workflows/(.+)\\?ref=${HEAD}$`),
      reply: (args) => {
        const name = /workflows\/([^?]+)\?/.exec(args.at(-1) ?? "")?.[1] ?? "";
        const text = files[decodeURIComponent(name)];
        return text === undefined ? notFound() : ok(text);
      },
    },
    {
      match: /^api --method GET repos\/([^/]+\/[^/]+)\/commits\/(\S+) --jq \.sha$/,
      reply: (args) => {
        const [, owner, name, , tag] = (args[3] ?? "").split("/");
        const sha = tags[`${owner}/${name}@${decodeURIComponent(tag ?? "")}`];
        return sha === undefined || sha === null ? notFound() : ok(`${sha}\n`);
      },
    },
  ]);
}

async function workflowProblems(files: Record<string, string>, tags?: Record<string, string | null>) {
  const fake = github(files, tags);
  const problems = await checkWorkflowFiles(ghPullRequestSource(fake.gh, { repository: REPOSITORY, headSha: HEAD }));
  return { problems, calls: fake.calls };
}

describe("the PR check", () => {
  it.each([
    ["feat(slice-1c): one shell, one agent, in the left panel", "slice-1c/walking-skeleton"],
    ["ci(slice-d1): delivery pipeline", "slice-d1/delivery"],
    ["feat(slice-6)!: rename the toggle-key config field", "slice-6/terminal-ui"],
    ["fix(ptyd): keep the pane when its owner is stuck", "fix/stuck-owner"],
    ["docs: delivery plan", "docs/delivery-plan"],
    ["revert: undo the toggle rename", "fix/undo-toggle"],
    ["chore(main): release 0.1.0", "release-please--branches--main"],
    ["fix(deps): bump esbuild from 0.28.2 to 0.28.3", "dependabot/npm_and_yarn/esbuild-0.28.3"],
    [
      "chore(deps-dev): bump the dev-tools group across 1 directory with 4 updates, including @types/node and vitest",
      "dependabot/npm_and_yarn/dev-tools-6f0c2b4a1e",
    ],
    [
      "test(deps): bump debian from trixie-20261001-slim to trixie-20261015-slim in /test/live",
      "dependabot/docker/test/live/debian-trixie-20261015-slim",
    ],
  ])("the PR check accepts %s", (title, branch) => {
    expect(sameRepo(title, branch)).toEqual([]);
  });

  it.each([
    ["Feat: an uppercase type", "feat/x"],
    ["feature: an unknown type", "feat/x"],
    ["feat(Slice-1c): an uppercase scope", "feat/x"],
    ["feat(): an empty scope", "feat/x"],
    ["feat (core): a space before the scope", "feat/x"],
    ["feat:no space after the colon", "feat/x"],
    ["feat: ", "feat/x"],
    ["feat: a trailing period.", "feat/x"],
    [`feat: ${"a".repeat(67)}`, "feat/x"],
    ["update the things", "feat/x"],
    ['Revert "feat(slice-1c): one shell"', "fix/revert"],
  ])("the PR check refuses %s", (title, branch) => {
    expect(sameRepo(title, branch)).not.toEqual([]);
  });

  it("the PR check requires a slice branch's id as the title's scope", () => {
    expect(sameRepo("feat(slice-1c): one shell", "slice-1c/walking-skeleton")).toEqual([]);
    expect(sameRepo("feat(slice-2a): one shell", "slice-1c/walking-skeleton")).toEqual([
      "a slice-1c/… branch's title has the scope (slice-1c)",
    ]);
    expect(sameRepo("feat: one shell", "slice-1c/walking-skeleton")).toEqual([
      "a slice-1c/… branch's title has the scope (slice-1c)",
    ]);
  });

  it("the PR check refuses a branch outside the naming scheme, accepts the bots' branches, and checks only the title of a fork's branch", () => {
    for (const branch of ["main", "patch-1", "feat/Upper", `feat/${"x".repeat(51)}`, "perf/faster", "slice-1c/", "feat/a/b"]) {
      expect(sameRepo("feat: a change", branch)).toEqual([`the branch ${branch} is outside the naming scheme (CONTRIBUTING)`]);
    }
    for (const branch of ["dependabot/npm_and_yarn/vitest-5.0.4", "release-please--branches--main"]) {
      expect(sameRepo("chore(deps-dev): bump vitest from 5.0.3 to 5.0.4", branch)).toEqual([]);
    }
    for (const branch of ["patch-1", "main", "dependabot/npm_and_yarn/x"]) {
      expect(checkTitleAndBranch({ title: "fix: a typo", branch, fork: true })).toEqual([]);
    }
    expect(checkTitleAndBranch({ title: "Fix a typo", branch: "patch-1", fork: true })).not.toEqual([]);
    expect(
      checkTitleAndBranch({ title: `chore(deps): ${"b".repeat(70)}`, branch: "dependabot/npm_and_yarn/x", fork: true }),
    ).toEqual(["the title is longer than 72 characters"]);
  });

  it("the PR check applies the base branch's workflow rules to the PR's workflow files, read through the API as data", async () => {
    const { problems, calls } = await workflowProblems({
      "ci.yml": workflow("build", "ubuntu-latest"),
      "x.yml": `${workflow("other")}# \${{ github.event.pull_request.title }} is only text here\n`,
    });

    expect(problems).toEqual([
      ".github/workflows/ci.yml:7  [runner] runners are ubuntu-24.04, ubuntu-24.04-arm or macos-26, never -latest",
    ]);
    for (const call of calls) {
      expect(call.args.slice(0, 3)).toEqual(["api", "--method", "GET"]);
    }
    expect(calls.filter((call) => call.args.some((arg) => arg.includes(`ref=${HEAD}`)))).toHaveLength(3);
  });

  it("the PR check fails a PR that adds a job named ci-ok or pr-title outside their workflows", async () => {
    const { problems } = await workflowProblems({ "ci.yml": workflow(), "sneaky.yml": workflow("ci-ok") });

    expect(problems).toEqual([".github/workflows/sneaky.yml:6  [required-check-name] only ci.yml has a job named ci-ok"]);
  });

  it("the PR check fails when a pinned action's SHA is not the commit its tag comment names", async () => {
    const moved = await workflowProblems({ "ci.yml": workflow() }, { "actions/checkout@v7.0.1": "1".repeat(40) });
    expect(moved.problems).toEqual([
      `.github/workflows/ci.yml:12  [pinned-sha] actions/checkout@${CHECKOUT_SHA} is not v7.0.1, which names ${"1".repeat(40)}`,
    ]);

    const missing = await workflowProblems({ "ci.yml": workflow() }, {});
    expect(missing.problems).toEqual([
      ".github/workflows/ci.yml:12  [pinned-sha] actions/checkout has no tag v7.0.1",
    ]);

    const kept = await workflowProblems({ "ci.yml": workflow() });
    expect(kept.problems).toEqual([]);
  });

  it("the PR check passes a PR whose head has no workflow directory", async () => {
    const fake = fakeGh([{ match: /contents\/\.github\/workflows\?ref=/, reply: notFound }]);

    expect(await checkWorkflowFiles(ghPullRequestSource(fake.gh, { repository: REPOSITORY, headSha: HEAD }))).toEqual([]);
  });

  it("agents run the PR check on a title and branch before gh pr create", async () => {
    const good = await runScript(checkPr, ["--title", "feat(slice-1c): one shell", "--branch", "slice-1c/walking-skeleton"]);
    expect(good.code).toBe(0);

    const bad = await runScript(checkPr, ["--title", "Add a thing.", "--branch", "slice-1c/walking-skeleton"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("the title is not a Conventional Commit");
  });
});
