import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { desiredSettings, runSetup } from "../../scripts/delivery/lib/github-setup.mjs";
import { FakeRepositorySettings } from "./fake-github-settings.ts";
import { repo } from "./helpers.ts";

const REPOSITORY = "YOLOVibeCode/tyto-desk";

type Run = { code: number; output: string; asked: string[] };

async function setup(
  github: FakeRepositorySettings,
  mode: "check" | "apply",
  { appSlug = null as string | null, isTTY = true, answer = true } = {},
): Promise<Run> {
  const lines: string[] = [];
  const asked: string[] = [];
  const code = await runSetup({
    mode,
    gh: github.gh,
    repository: REPOSITORY,
    appSlug,
    isTTY,
    confirm: async (question: string) => {
      asked.push(question);
      return answer;
    },
    print: (line: string) => lines.push(line),
  });
  return { code, output: lines.join("\n"), asked };
}

/** A repository on which `--apply` already ran. */
async function appliedRepository(appSlug: string | null = null): Promise<FakeRepositorySettings> {
  const github = new FakeRepositorySettings();
  expect((await setup(github, "apply", { appSlug })).code).toBe(0);
  github.calls.length = 0;
  return github;
}

describe("github-setup", () => {
  it("github-setup plans squash-only merges with the PR title and body as the commit, auto-merge and branch deletion", () => {
    expect(desiredSettings({ ownerId: 4242, appId: null }).merging).toEqual({
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      allow_auto_merge: true,
      delete_branch_on_merge: true,
      squash_merge_commit_title: "PR_TITLE",
      squash_merge_commit_message: "PR_BODY",
      allow_update_branch: true,
    });
  });

  it("github-setup's main ruleset requires pr-title and ci-ok from GitHub Actions, signed linear history and a PR with 0 approvals, and has no bypass actor", () => {
    expect(desiredSettings({ ownerId: 4242, appId: 1234567 }).rulesets.main).toEqual({
      name: "main",
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        { type: "required_linear_history" },
        { type: "required_signatures" },
        {
          type: "pull_request",
          parameters: {
            required_approving_review_count: 0,
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_review_thread_resolution: false,
            allowed_merge_methods: ["squash"],
          },
        },
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: false,
            do_not_enforce_on_create: false,
            required_status_checks: [
              { context: "pr-title", integration_id: 15368 },
              { context: "ci-ok", integration_id: 15368 },
            ],
          },
        },
      ],
    });
  });

  it("github-setup's tags and release branch rulesets let only the release App create, move or delete, and have no bypass actor until the App exists", () => {
    const rules = [
      { type: "creation" },
      { type: "update", parameters: { update_allows_fetch_and_merge: false } },
      { type: "deletion" },
      { type: "non_fast_forward" },
    ];
    const before = desiredSettings({ ownerId: 4242, appId: null }).rulesets;
    const after = desiredSettings({ ownerId: 4242, appId: 1234567 }).rulesets;

    expect(before.tags).toEqual({
      name: "tags",
      target: "tag",
      enforcement: "active",
      bypass_actors: [],
      conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
      rules,
    });
    expect(before["release branch"]).toEqual({
      name: "release branch",
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions: { ref_name: { include: ["refs/heads/release-please--**"], exclude: [] } },
      rules,
    });
    for (const name of ["tags", "release branch"] as const) {
      expect(after[name].bypass_actors).toEqual([{ actor_id: 1234567, actor_type: "Integration", bypass_mode: "always" }]);
    }
    expect(after.main.bypass_actors).toEqual([]);
  });

  it("github-setup's release-please environment deploys only main, and publish deploys only v tags after the owner approves", () => {
    const { environments } = desiredSettings({ ownerId: 4242, appId: null });

    expect(environments["release-please"]).toEqual({
      reviewers: [],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      branch_policies: [{ name: "main", type: "branch" }],
    });
    expect(environments.publish).toEqual({
      reviewers: [{ type: "User", id: 4242 }],
      prevent_self_review: false,
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      branch_policies: [{ name: "v*", type: "tag" }],
    });
  });

  it("github-setup makes every outside contributor's PR wait for approval before workflows run", () => {
    const desired = desiredSettings({ ownerId: 4242, appId: null });

    expect(desired.forkApproval).toEqual({ approval_policy: "all_external_contributors" });
    expect(desired.actions).toEqual({ enabled: true, allowed_actions: "selected", sha_pinning_required: true });
    expect(desired.selectedActions).toEqual({
      github_owned_allowed: true,
      verified_allowed: false,
      patterns_allowed: ["dependabot/fetch-metadata@*", "googleapis/release-please-action@*"],
    });
    expect(desired.workflow).toEqual({ default_workflow_permissions: "read", can_approve_pull_request_reviews: false });
  });

  it("github-setup --check changes nothing and exits 1 naming each setting that differs", async () => {
    const github = new FakeRepositorySettings();

    const run = await setup(github, "check");

    expect(run.code).toBe(1);
    expect(github.writes()).toEqual([]);
    expect(run.asked).toEqual([]);
    for (const name of [
      "merging",
      "secret scanning",
      "dependabot alerts",
      "dependabot security updates",
      "private vulnerability reporting",
      "actions",
      "allowed actions",
      "outside contributors",
      "immutable releases",
      "environment release-please",
      "environment publish",
      "label live",
      "label owner-merge",
      "ruleset main",
      "ruleset tags",
      "ruleset release branch",
    ]) {
      expect(run.output).toMatch(new RegExp(`differs +${name.replace(/ /g, " ")}\\b`));
    }
    expect(run.output).toMatch(/ok +workflow token/);

    const clean = await setup(await appliedRepository(), "check");
    expect(clean.code).toBe(0);
    expect(clean.output).not.toContain("differs");
  });

  it("github-setup --apply asks on a TTY, changes only what differs, and a second run changes nothing", async () => {
    const noTerminal = new FakeRepositorySettings();
    const refused = await setup(noTerminal, "apply", { isTTY: false });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("--apply asks on an interactive terminal");
    expect(noTerminal.writes()).toEqual([]);

    const declinedRepo = new FakeRepositorySettings();
    const declined = await setup(declinedRepo, "apply", { answer: false });
    expect(declined.code).toBe(77);
    expect(declined.asked).toEqual([expect.stringContaining("as alex")]);
    expect(declinedRepo.writes()).toEqual([]);

    const github = new FakeRepositorySettings();
    github.labels.set("live", { name: "live", color: "0e8a16", description: "Runs the live suite on this pull request" });
    const first = await setup(github, "apply");
    expect(first.code).toBe(0);
    expect(github.writes()).not.toContainEqual(expect.stringContaining("labels/live"));
    expect(github.writes()).not.toContainEqual(expect.stringContaining("actions/permissions/workflow"));
    expect(github.writes()).toContain("api --method POST repos/YOLOVibeCode/tyto-desk/labels");

    github.calls.length = 0;
    const second = await setup(github, "apply");
    expect(second.code).toBe(0);
    expect(second.asked).toEqual([]);
    expect(github.writes()).toEqual([]);
    expect(second.output).toContain("Nothing to change");
  });

  it("github-setup gives the tags and release branch rulesets the App as their only bypass actor once its slug is set", async () => {
    const github = await appliedRepository();

    const run = await setup(github, "apply", { appSlug: "tyto-desk-release" });

    expect(run.code).toBe(1);
    expect(github.writes().filter((call) => call.includes("rulesets"))).toHaveLength(2);
    expect(run.output).toMatch(/differs +release-please secrets/);
    expect(github.rulesets.find((r) => r.name === "tags")?.bypass_actors).toEqual([
      { actor_id: 1234567, actor_type: "Integration", bypass_mode: "always" },
    ]);

    github.environmentSecrets.set("release-please", ["RELEASE_APP_PRIVATE_KEY"]);
    github.environmentVariables.set("release-please", ["RELEASE_APP_CLIENT_ID"]);
    expect((await setup(github, "check", { appSlug: "tyto-desk-release" })).code).toBe(0);
  });

  it("github-setup names a secret that should not exist, and never removes one", async () => {
    const github = await appliedRepository();
    github.repositorySecrets = ["NPM_TOKEN"];
    github.environmentSecrets.set("publish", ["SIGNING_KEY"]);

    const run = await setup(github, "apply");

    expect(run.code).toBe(1);
    expect(run.output).toMatch(/differs +secrets/);
    expect(run.output).toContain("NPM_TOKEN");
    expect(run.output).toContain("SIGNING_KEY");
    expect(github.writes()).toEqual([]);
  });

  it("github-setup never runs gh auth status and never reads a secret's value", async () => {
    const github = new FakeRepositorySettings();
    await setup(github, "check", { appSlug: "tyto-desk-release" });
    await setup(github, "apply", { appSlug: "tyto-desk-release" });
    const sources = await Promise.all(
      ["scripts/delivery/github-setup.mjs", "scripts/delivery/lib/github-setup.mjs"].map((path) => readFile(join(repo, path), "utf8")),
    );

    expect(github.calls.length).toBeGreaterThan(20);
    for (const { args } of github.calls) {
      expect(args).not.toContain("auth");
      expect(args.join(" ")).not.toMatch(/\/secrets\b|public-key/);
      if (args[0] === "secret" || args[0] === "variable") {
        expect(args).toEqual(expect.arrayContaining(["list", "--json", "name"]));
        expect(args).toHaveLength(args.includes("--env") ? 8 : 6);
      }
    }
    for (const source of sources) expect(source).not.toMatch(/auth\s+status|"auth",\s*"status"/);
  });
});
