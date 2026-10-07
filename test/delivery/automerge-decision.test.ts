import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { automergeDecision, decideAutomerge } from "../../scripts/delivery/lib/automerge-decision.mjs";
import { fakeGh, ok } from "./fake-gh.ts";
import type { RunResult } from "../../scripts/delivery/lib/run.mjs";
import { repo, runScript } from "./helpers.ts";

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

/** gh answering main's active rules with `rules`, one page, or failing. */
function rulesApi(reply: RunResult) {
  return fakeGh([{ match: new RegExp(`^api --method GET --paginate --slurp repos/${REPOSITORY}/rules/branches/main\\?per_page=100$`), reply: () => reply }]);
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

      const decision = await decideAutomerge(gh, { repository: REPOSITORY, updates: [update()] });

      expect(decision.merge).toBe(merge);
      if (!merge) expect(decision.reason).toContain("interim rule");
    },
  );

  it("the auto-merge decision reads main's rules only for an update it would merge", async () => {
    const { gh, calls } = rulesApi(ok([[requiredChecks(FROM_ACTIONS)]]));

    const decision = await decideAutomerge(gh, { repository: REPOSITORY, updates: [update({ dependencyName: "esbuild" })] });

    expect(decision.merge).toBe(false);
    expect(calls).toEqual([]);
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
});
