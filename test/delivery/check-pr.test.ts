import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkTitleAndBranch, checkWorkflowFiles, ghPullRequestSource } from "../../scripts/delivery/lib/pr-check.mjs";
import { RELEASE_BRANCH } from "../../scripts/delivery/lib/release-branch.mjs";
import { fakeGh, notFound, ok } from "./fake-gh.ts";
import { repo, runScript } from "./helpers.ts";

const checkPr = join(repo, "scripts/delivery/check-pr.mjs");
const HEAD = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const TAG_OBJECT = "7a6b5c4d3e2f10293847566574839201a2b3c4d5";
const REPOSITORY = "YOLOVibeCode/tyto-desk";

const sameRepo = (title: string, branch: string) => checkTitleAndBranch({ title, branch, fork: false });

/** A workflow that keeps every rule of §23.7; `pin` is the checkout's tag comment. */
function workflow(jobId = "build", runsOn = "ubuntu-24.04", pin = "v7.0.1"): string {
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
    `      - uses: actions/checkout@${CHECKOUT_SHA} # ${pin}`,
    "        with:",
    "          persist-credentials: false",
    "",
  ].join("\n");
}

/** A tag: the commit a lightweight tag names, or an annotated tag's object and the commit it names. */
type Tag = string | { annotated: string; commit: string };

/**
 * The REST API as gh sees it: the PR head's workflow files, and each action's tags as git refs. Branches and commits
 * are not tags, so `git/ref/tags/<name>` does not find them.
 */
function github(files: Record<string, string>, tags: Record<string, Tag> = { "actions/checkout@v7.0.1": CHECKOUT_SHA }) {
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
      match: /^api --method GET repos\/[^/]+\/[^/]+\/git\/ref\/tags\/\S+$/,
      reply: (args) => {
        const [, owner, name, , , , ...rest] = (args[3] ?? "").split("/");
        const tagName = rest.map(decodeURIComponent).join("/");
        const tag = tags[`${owner}/${name}@${tagName}`];
        if (tag === undefined) return notFound();
        const object = typeof tag === "string" ? { type: "commit", sha: tag } : { type: "tag", sha: tag.annotated };
        return ok({ ref: `refs/tags/${tagName}`, object });
      },
    },
    {
      match: /^api --method GET repos\/[^/]+\/[^/]+\/git\/tags\/[0-9a-f]{40}$/,
      reply: (args) => {
        const sha = (args[3] ?? "").split("/").at(-1);
        const tag = Object.values(tags).find((t) => typeof t !== "string" && t.annotated === sha);
        return tag === undefined || typeof tag === "string" ? notFound() : ok({ sha, object: { type: "commit", sha: tag.commit } });
      },
    },
  ]);
}

async function workflowProblems(files: Record<string, string>, tags?: Record<string, Tag>) {
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
    ["chore(main): release 0.1.0", RELEASE_BRANCH],
    ["fix(deps): bump esbuild from 0.28.2 to 0.28.3", "dependabot/npm_and_yarn/esbuild-0.28.3"],
    [
      "chore(deps-dev): bump the dev-tools group across 1 directory with 4 updates, including @types/node and vitest",
      "dependabot/npm_and_yarn/dev-tools-6f0c2b4a1e",
    ],
    [
      "test(deps): bump debian from trixie-20261001-slim to trixie-20261015-slim in /test/live/image",
      "dependabot/docker/test/live/image/debian-trixie-20261015-slim",
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

  it.each([
    { title: "feat(slice-1c): one shell", problems: [] },
    { title: "feat(slice-2a): one shell", problems: ["a slice-1c/… branch's title has the scope (slice-1c)"] },
    { title: "feat: one shell", problems: ["a slice-1c/… branch's title has the scope (slice-1c)"] },
  ])("the PR check requires a slice branch's id as the title's scope ($title)", ({ title, problems }) => {
    expect(sameRepo(title, "slice-1c/walking-skeleton")).toEqual(problems);
  });

  const outside = (branch: string) => [`the branch ${branch} is outside the naming scheme (CONTRIBUTING)`];
  it.each([
    { label: "refuses main", title: "feat: a change", branch: "main", fork: false, problems: outside("main") },
    { label: "refuses patch-1", title: "feat: a change", branch: "patch-1", fork: false, problems: outside("patch-1") },
    { label: "refuses an uppercase topic", title: "feat: a change", branch: "feat/Upper", fork: false, problems: outside("feat/Upper") },
    { label: "refuses a topic over 50 characters", title: "feat: a change", branch: `feat/${"x".repeat(51)}`, fork: false, problems: outside(`feat/${"x".repeat(51)}`) },
    { label: "refuses a type with no branch prefix", title: "feat: a change", branch: "perf/faster", fork: false, problems: outside("perf/faster") },
    { label: "refuses an empty slice topic", title: "feat: a change", branch: "slice-1c/", fork: false, problems: outside("slice-1c/") },
    { label: "refuses a nested topic", title: "feat: a change", branch: "feat/a/b", fork: false, problems: outside("feat/a/b") },
    { label: "accepts Dependabot's branch", title: "chore(deps-dev): bump vitest from 5.0.3 to 5.0.4", branch: "dependabot/npm_and_yarn/vitest-5.0.4", fork: false, problems: [] },
    { label: "accepts the release PR's branch", title: "chore(deps-dev): bump vitest from 5.0.3 to 5.0.4", branch: RELEASE_BRANCH, fork: false, problems: [] },
    { label: "checks only the title of a fork's patch-1", title: "fix: a typo", branch: "patch-1", fork: true, problems: [] },
    { label: "checks only the title of a fork's main", title: "fix: a typo", branch: "main", fork: true, problems: [] },
    { label: "checks only the title of a fork's dependabot/ branch", title: "fix: a typo", branch: "dependabot/npm_and_yarn/x", fork: true, problems: [] },
    {
      label: "checks a fork's title by the rules for people",
      title: "Fix a typo",
      branch: "patch-1",
      fork: true,
      problems: ["the title is not a Conventional Commit: type(scope)!: subject, with a lowercase type from feat, fix, perf, refactor, docs, test, build, ci, chore, revert"],
    },
    {
      label: "holds a fork's dependabot/ branch to 72 characters",
      title: `chore(deps): ${"b".repeat(70)}`,
      branch: "dependabot/npm_and_yarn/x",
      fork: true,
      problems: ["the title is longer than 72 characters"],
    },
  ])(
    "the PR check refuses a branch outside the naming scheme, accepts the bots' branches, and checks only the title of a fork's branch ($label)",
    ({ title, branch, fork, problems }) => {
      expect(checkTitleAndBranch({ title, branch, fork })).toEqual(problems);
    },
  );

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

  it.each([
    {
      label: "a tag that names another commit",
      pin: "v7.0.1",
      tags: { "actions/checkout@v7.0.1": "1".repeat(40) },
      problems: [`.github/workflows/ci.yml:12  [pinned-sha] actions/checkout@${CHECKOUT_SHA} is not v7.0.1, which names ${"1".repeat(40)}`],
    },
    { label: "a tag the action does not have", pin: "v7.0.1", tags: {}, problems: [".github/workflows/ci.yml:12  [pinned-sha] actions/checkout has no tag v7.0.1"] },
    { label: "a branch named in the comment", pin: "main", tags: { "actions/checkout@v7.0.1": CHECKOUT_SHA }, problems: [".github/workflows/ci.yml:12  [pinned-sha] actions/checkout has no tag main"] },
    { label: "a short commit named in the comment", pin: "3d3c42e", tags: { "actions/checkout@v7.0.1": CHECKOUT_SHA }, problems: [".github/workflows/ci.yml:12  [pinned-sha] actions/checkout has no tag 3d3c42e"] },
  ])("the PR check fails when a pinned action's SHA is not the commit its tag comment names ($label)", async ({ pin, tags, problems }) => {
    expect((await workflowProblems({ "ci.yml": workflow("build", "ubuntu-24.04", pin) }, tags)).problems).toEqual(problems);
  });

  it.each([
    { label: "a lightweight tag", tags: { "actions/checkout@v7.0.1": CHECKOUT_SHA } },
    { label: "an annotated tag", tags: { "actions/checkout@v7.0.1": { annotated: TAG_OBJECT, commit: CHECKOUT_SHA } } },
  ])("the PR check passes a pinned action whose SHA is the commit its tag names ($label)", async ({ tags }) => {
    expect((await workflowProblems({ "ci.yml": workflow() }, tags)).problems).toEqual([]);
  });

  const many = (count: number, make: (i: number) => [string, string]) => Object.fromEntries(Array.from({ length: count }, (_, i) => make(i)));

  it.each([
    { count: 25, problems: [] },
    {
      count: 26,
      problems: [".github/workflows  [cap] the head has 26 workflow files; the PR check reads at most 25, so it fails closed"],
    },
  ])("the PR check reads at most 25 workflow files and fails closed above that, reading none ($count files)", async ({ count, problems }) => {
    const files = many(count, (i) => [`w${String(i).padStart(2, "0")}.yml`, workflow()]);

    const result = await workflowProblems(files);

    expect(result.problems).toEqual(problems);
    const reads = result.calls.filter((call) => call.args.includes("Accept: application/vnd.github.raw"));
    expect(reads).toHaveLength(count > 25 ? 0 : count);
  });

  /** A workflow whose one job pins `count` distinct actions, each to the commit its tag names. */
  function pinning(count: number): { text: string; tags: Record<string, Tag> } {
    const sha = (i: number) => i.toString(16).padStart(40, "a");
    const steps = Array.from({ length: count }, (_, i) => `      - uses: example/action-${i}@${sha(i)} # v1.0.0`);
    const tags = many(count, (i) => [`example/action-${i}@v1.0.0`, sha(i)]);
    return { text: `${workflow()}${steps.join("\n")}\n`, tags: { ...tags, "actions/checkout@v7.0.1": CHECKOUT_SHA } };
  }

  it.each([
    { count: 24, problems: [] },
    {
      count: 25,
      problems: [
        ".github/workflows  [cap] the workflow files pin 26 distinct actions (action and tag); the PR check looks up at most 25, so it fails closed",
      ],
    },
  ])(
    "the PR check looks up at most 25 distinct pinned actions and fails closed above that, looking up none ($count pins besides checkout)",
    async ({ count, problems }) => {
      const { text, tags } = pinning(count);

      const result = await workflowProblems({ "ci.yml": text }, tags);

      expect(result.problems).toEqual(problems);
      const lookups = result.calls.filter((call) => /\/git\/ref\/tags\//.test(call.args.join(" ")));
      expect(lookups).toHaveLength(count + 1 > 25 ? 0 : count + 1);
    },
  );

  it("the PR check fails closed when the API may not have listed every entry of .github/workflows (1,000 or more)", async () => {
    const entries = Array.from({ length: 1000 }, (_, i) => ({ name: `n${i}.txt`, path: `.github/workflows/n${i}.txt`, type: "file" }));
    const fake = fakeGh([{ match: /contents\/\.github\/workflows\?ref=/, reply: () => ok(entries) }]);

    const problems = await checkWorkflowFiles(ghPullRequestSource(fake.gh, { repository: REPOSITORY, headSha: HEAD }));

    expect(problems).toEqual([
      ".github/workflows  [cap] the API listed 1000 entries of .github/workflows, the most it lists, so a workflow may be missing; the PR check fails closed",
    ]);
    expect(fake.calls).toHaveLength(1);
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
