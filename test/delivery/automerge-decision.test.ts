import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { automergeDecision, decideAutomerge } from "../../scripts/delivery/lib/automerge-decision.mjs";
import { fakeGh, ok } from "./fake-gh.ts";
import type { Runner, RunResult } from "../../scripts/delivery/lib/run.mjs";
import { repo, runScript } from "./helpers.ts";
import { ownerPaths } from "./owner-paths.ts";

const script = join(repo, "scripts/delivery/automerge-decision.mjs");
const REPOSITORY = "YOLOVibeCode/tyto-desk";

/** One entry of dependabot/fetch-metadata's updated-dependencies-json. */
function update(over: Record<string, unknown> = {}) {
  return {
    dependencyName: "vitest",
    dependencyType: "direct:development",
    updateType: "version-update:semver-patch",
    directory: "/",
    packageEcosystem: "npm_and_yarn",
    targetBranch: "main",
    prevVersion: "5.0.3",
    newVersion: "5.0.4",
    compatScore: 0,
    maintainerChanges: false,
    dependencyGroup: "",
    alertState: "",
    ghsaId: "",
    cvss: 0,
    ...over,
  };
}

/** One rule of `GET repos/<r>/rules/branches/main`: the required checks, each with the app it must come from. */
function requiredChecks(checks: { context: string; integration_id?: number }[]) {
  return {
    type: "required_status_checks",
    parameters: { strict_required_status_checks_policy: false, do_not_enforce_on_create: false, required_status_checks: checks },
    ruleset_source_type: "Repository",
    ruleset_source: REPOSITORY,
    ruleset_id: 1,
  };
}
const FROM_ACTIONS = [
  { context: "pr-title", integration_id: 15368 },
  { context: "ci-ok", integration_id: 15368 },
];

/** The head commit of Dependabot's pull request (#6), as the event names it. */
const HEAD = "f8e753e9257b286ffb694b44fc40f49f8e39b252";

/**
 * One entry of `GET repos/<r>/pulls/<n>/commits`, shaped like a real Dependabot commit: authored by dependabot[bot],
 * committed and signed by GitHub (web-flow).
 */
function commit(over: { sha?: string; login?: string | null; verified?: boolean } = {}) {
  const verified = over.verified ?? true;
  return {
    sha: over.sha ?? HEAD,
    author: over.login === null ? null : { login: over.login ?? "dependabot[bot]", id: 49699333, type: "Bot" },
    committer: { login: "web-flow", id: 19864447, type: "User" },
    commit: {
      author: { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" },
      committer: { name: "GitHub", email: "noreply@github.com" },
      verification: { verified, reason: verified ? "valid" : "unsigned" },
    },
  };
}

type DependabotPr = {
  commits?: object[];
  files?: string[];
  head?: string;
  commitCount?: number;
  changedFiles?: number;
  rules?: RunResult;
  failCommits?: boolean;
};

/** gh against Dependabot's pull request #6 (its commits, files and head) and main's active rules, one page each. */
function dependabotPr({
  commits = [commit()],
  files = ["package-lock.json", "package.json"],
  head = HEAD,
  commitCount = commits.length,
  changedFiles = files.length,
  rules = ok([[requiredChecks(FROM_ACTIONS)]]),
  failCommits = false,
}: DependabotPr = {}) {
  return fakeGh([
    {
      match: new RegExp(`^api --method GET --paginate --slurp repos/${REPOSITORY}/pulls/6/commits\\?per_page=100$`),
      reply: () => (failCommits ? { code: 1, stdout: "", stderr: "gh: Server Error (HTTP 502)\n" } : ok([commits])),
    },
    {
      match: new RegExp(`^api --method GET --paginate --slurp repos/${REPOSITORY}/pulls/6/files\\?per_page=100$`),
      reply: () => ok([files.map((filename) => ({ filename }))]),
    },
    {
      match: new RegExp(`^api --method GET repos/${REPOSITORY}/pulls/6$`),
      reply: () => ok({ number: 6, head: { sha: head }, commits: commitCount, changed_files: changedFiles }),
    },
    {
      match: new RegExp(`^api --method GET --paginate --slurp repos/${REPOSITORY}/rules/branches/main\\?per_page=100$`),
      reply: () => rules,
    },
  ]);
}

/** gh answering main's active rules with `rules`, one page, or failing; Dependabot's own pull request otherwise. */
function rulesApi(reply: RunResult) {
  return dependabotPr({ rules: reply });
}

/** The decision for pull request #6 at HEAD. */
function decide(gh: Runner, updates: unknown[] = [update()]) {
  return decideAutomerge(gh, { repository: REPOSITORY, number: 6, headSha: HEAD, updates, ownerPaths: ownerPaths.paths });
}

describe("the auto-merge decision", () => {
  it.each([
    { label: "a patch of vitest", over: {}, merge: true },
    { label: "a patch of typescript", over: { dependencyName: "typescript" }, merge: true },
    { label: "a patch of yaml", over: { dependencyName: "yaml" }, merge: true },
    { label: "a patch of @types/node", over: { dependencyName: "@types/node" }, merge: true },
    { label: "a patch of @types/chrome", over: { dependencyName: "@types/chrome" }, merge: true },
    { label: "a patch of esbuild", over: { dependencyName: "esbuild" }, merge: false },
    { label: "a patch of vite", over: { dependencyName: "vite" }, merge: false },
    { label: "a patch of @typesx/node", over: { dependencyName: "@typesx/node" }, merge: false },
    { label: "a patch of typescript-eslint", over: { dependencyName: "typescript-eslint" }, merge: false },
    { label: "a minor update of vitest", over: { updateType: "version-update:semver-minor" }, merge: false },
    { label: "a major update of vitest", over: { updateType: "version-update:semver-major" }, merge: false },
    { label: "an update of unknown size", over: { updateType: "" }, merge: false },
    { label: "a runtime dependency", over: { dependencyType: "direct:production" }, merge: false },
    { label: "an indirect dependency", over: { dependencyType: "indirect" }, merge: false },
    { label: "a GitHub Actions update", over: { packageEcosystem: "github_actions", dependencyName: "actions/checkout" }, merge: false },
    { label: "the live image's base", over: { packageEcosystem: "docker", dependencyName: "debian" }, merge: false },
  ])(
    "the auto-merge decision allows only patch updates of @types, typescript, vitest and yaml as development dependencies ($label)",
    ({ over, merge }) => {
      expect(automergeDecision([update(over)], { checksRequired: true }).merge).toBe(merge);
    },
  );

  it("the auto-merge decision refuses a group with any member outside the allowed class", () => {
    const allowed = [update(), update({ dependencyName: "@types/node", dependencyGroup: "dev-tools" })];
    const mixed = [...allowed, update({ dependencyName: "esbuild", dependencyGroup: "dev-tools" })];

    expect(automergeDecision(allowed, { checksRequired: true })).toEqual({ merge: true, reason: "patch updates of allowlisted dev tools" });
    expect(automergeDecision(mixed, { checksRequired: true })).toEqual({
      merge: false,
      reason: "esbuild is not a patch update of an allowlisted dev tool (@types/*, typescript, vitest, yaml)",
    });
  });

  it.each([[[]], [{ not: "a list" }], [null]])("the auto-merge decision refuses what is not a list of updates (%j)", (updates) => {
    expect(automergeDecision(updates, { checksRequired: true }).merge).toBe(false);
  });

  it.each([
    { label: "no rules yet", reply: ok([[]]), merge: false },
    { label: "only ci-ok required", reply: ok([[requiredChecks([{ context: "ci-ok", integration_id: 15368 }])]]), merge: false },
    { label: "both checks from any app", reply: ok([[requiredChecks([{ context: "pr-title" }, { context: "ci-ok" }])]]), merge: false },
    { label: "the rules could not be read", reply: { code: 1, stdout: "", stderr: "gh: Server Error (HTTP 500)\n" }, merge: false },
    { label: "pr-title and ci-ok from GitHub Actions", reply: ok([[{ type: "pull_request", parameters: {} }, requiredChecks(FROM_ACTIONS)]]), merge: true },
  ])(
    "the auto-merge decision turns auto-merge on only once main's rules require pr-title and ci-ok from GitHub Actions, the interim rule (D54) ($label)",
    async ({ reply, merge }) => {
      const { gh } = rulesApi(reply);

      const decision = await decide(gh);

      expect(decision.merge).toBe(merge);
      if (!merge) expect(decision.reason).toContain("interim rule");
    },
  );

  it("the auto-merge decision reads nothing for an update it would not merge", async () => {
    const { gh, calls } = rulesApi(ok([[requiredChecks(FROM_ACTIONS)]]));

    const decision = await decide(gh, [update({ dependencyName: "esbuild" })]);

    expect(decision.merge).toBe(false);
    expect(calls).toEqual([]);
  });

  const STRANGER = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
  it.each([
    { label: "a commit someone else authored", pr: { commits: [commit({ sha: STRANGER, login: "rvegajr" }), commit()] }, reason: "commit 1a2b3c4 is not Dependabot's" },
    { label: "a commit that names Dependabot but GitHub did not sign", pr: { commits: [commit({ verified: false })] }, reason: "commit f8e753e is not Dependabot's" },
    { label: "a commit whose author is no GitHub account", pr: { commits: [commit({ login: null })] }, reason: "commit f8e753e is not Dependabot's" },
    { label: "more commits than the API listed", pr: { commitCount: 251 }, reason: "the API listed only 1 of its 251 commits" },
    { label: "commits that end before the event's head", pr: { commits: [commit({ sha: STRANGER })] }, reason: "its commits do not end at the head commit the event named" },
    { label: "a head that moved after the event", pr: { head: STRANGER }, reason: "its head moved after the event" },
  ])("the auto-merge decision refuses a PR with a commit Dependabot did not author, or a head it did not judge ($label)", async ({ pr, reason }) => {
    const { gh } = dependabotPr(pr);

    expect(await decide(gh)).toEqual({ merge: false, reason });
  });

  it.each([
    { label: "a workflow", pr: { files: [".github/workflows/ci.yml", "package.json"] }, reason: "it is owner-merge (.github/**)" },
    { label: "a nested CLAUDE.md", pr: { files: ["package.json", "packages/node/CLAUDE.md"] }, reason: "it is owner-merge (**/CLAUDE.md)" },
    { label: "the agent rules in docs/CONTRIBUTING.md", pr: { files: ["docs/CONTRIBUTING.md"] }, reason: "it is owner-merge (docs/CONTRIBUTING.md)" },
    { label: "a file list the API cut short", pr: { files: ["package.json"], changedFiles: 3001 }, reason: "it is owner-merge (the API listed only 1 of 3001 files)" },
  ])("the auto-merge decision refuses a PR that touches an owner-merge path ($label)", async ({ pr, reason }) => {
    const { gh } = dependabotPr(pr);

    expect(await decide(gh)).toEqual({ merge: false, reason });
  });

  it("the auto-merge decision refuses a PR it cannot read", async () => {
    const { gh } = dependabotPr({ failCommits: true });

    expect(await decide(gh)).toEqual({ merge: false, reason: "the pull request's commits, files or head could not be read" });
  });

  it("the auto-merge decision turns auto-merge on for Dependabot's own patch of an allowlisted dev tool, read through the API", async () => {
    const { gh, calls } = dependabotPr();

    expect(await decide(gh)).toEqual({ merge: true, reason: "patch updates of allowlisted dev tools" });
    for (const call of calls) expect(call.args.slice(0, 3)).toEqual(["api", "--method", "GET"]);
  });

  it("the auto-merge decision reaches the workflow as one safe line per output", async () => {
    const output = join(await mkdtemp(join(tmpdir(), "automerge-")), "output");
    await writeFile(output, "");
    const injected = update({ dependencyName: "evil\nmerge=true`$(x)`", updateType: "version-update:semver-major" });

    const result = await runScript(script, [], {
      env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: output, UPDATED_DEPENDENCIES_JSON: JSON.stringify([injected]) },
    });

    expect(result.code).toBe(0);
    expect(await readFile(output, "utf8")).toBe(
      "merge=false\nreason=evilmergetruex is not a patch update of an allowlisted dev tool (@types/*, typescript, vitest, yaml)\n",
    );
  });

  it("the auto-merge decision refuses an allowed update when the workflow names no pull request and head commit", async () => {
    const output = join(await mkdtemp(join(tmpdir(), "automerge-")), "output");
    await writeFile(output, "");

    const result = await runScript(script, [], {
      env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: output, UPDATED_DEPENDENCIES_JSON: JSON.stringify([update()]), REPOSITORY },
    });

    expect(result.code).toBe(0);
    expect(await readFile(output, "utf8")).toBe(
      "merge=false\nreason=the workflow named no pull request and head commit (REPOSITORY, PR_NUMBER, PR_HEAD_SHA)\n",
    );
  });
});
