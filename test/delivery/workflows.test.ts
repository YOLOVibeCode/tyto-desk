import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { classifyChanges } from "../../scripts/delivery/lib/ci-changes.mjs";
import { repo } from "./helpers.ts";
import { ownerPathExamples, ownerPaths } from "./owner-paths.ts";

type Step = { id?: string; name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = { if?: string; needs?: string | string[]; outputs?: Record<string, string>; steps?: Step[] };
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };

/** A workflow under .github/workflows, parsed as the workflow rules read it. */
async function workflow(name: string): Promise<Workflow> {
  return parse(await readFile(join(repo, ".github", "workflows", name), "utf8")) as Workflow;
}

function job(file: Workflow, id: string): Job {
  const found = file.jobs[id];
  if (found === undefined) throw new Error(`no job ${id}`);
  return found;
}

function stepIndex(steps: Step[], test: (step: Step) => boolean): number {
  return steps.findIndex(test);
}

const usesAction = (action: string) => (step: Step) => (step.uses ?? "").toLowerCase().startsWith(`${action}@`);

/**
 * Whether GitHub's `paths` filter runs a workflow for a push that changes only `path`: the last pattern that matches
 * decides, `!` excludes, `**` matches any characters and `*` any but a slash.
 */
function pathsFilterRuns(patterns: string[], path: string): boolean {
  let runs = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const glob = negated ? raw.slice(1) : raw;
    let source = "";
    for (let i = 0; i < glob.length; i += 1) {
      const c = glob.charAt(i);
      if (glob.startsWith("**/", i)) {
        source += "(?:.*/)?";
        i += 2;
      } else if (glob.startsWith("**", i)) {
        source += ".*";
        i += 1;
      } else if (c === "*") source += "[^/]*";
      else source += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
    if (new RegExp(`^${source}$`).test(path)) runs = !negated;
  }
  return runs;
}

describe("the workflows", () => {
  it("dependabot-auto-merge runs only for Dependabot's own pull requests from this repository, on events Dependabot sent", async () => {
    const automerge = job(await workflow("dependabot-auto-merge.yml"), "automerge");

    const conditions = (automerge.if ?? "").split("&&").map((condition) => condition.trim());

    expect(automerge.if).not.toContain("||");
    expect(conditions.sort()).toEqual(
      [
        "github.event.pull_request.head.repo.full_name == github.repository",
        "github.event.pull_request.user.login == 'dependabot[bot]'",
        "github.event.sender.login == 'dependabot[bot]'",
      ].sort(),
    );
  });

  it("dependabot-auto-merge turns auto-merge on only for the head commit its decision judged", async () => {
    const steps = job(await workflow("dependabot-auto-merge.yml"), "automerge").steps ?? [];
    const decision = steps.find((step) => step.id === "decision");
    const merge = steps.find((step) => (step.run ?? "").includes("gh pr merge"));

    expect(decision?.env).toMatchObject({
      PR_NUMBER: "${{ github.event.pull_request.number }}",
      PR_HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
    });
    expect(merge?.env).toMatchObject({ PR_HEAD_SHA: "${{ github.event.pull_request.head.sha }}" });
    expect(merge?.run?.trim()).toBe('gh pr merge --auto --squash --match-head-commit "$PR_HEAD_SHA" "$PR_URL"');
  });

  it("build-darwin hands on the id and sha256 digest of the artifact pack uploaded", async () => {
    const build = await workflow("build-darwin.yml");
    const pack = job(build, "pack");
    const upload = (pack.steps ?? []).find(usesAction("actions/upload-artifact"));
    const outputs = (build.on.workflow_call as { outputs: Record<string, { value: string }> }).outputs;

    expect(upload?.id).toBe("upload");
    expect(pack.outputs).toMatchObject({
      "artifact-id": "${{ steps.upload.outputs.artifact-id }}",
      "artifact-digest": "${{ steps.upload.outputs.artifact-digest }}",
    });
    expect(outputs["artifact-id"]?.value).toBe("${{ jobs.pack.outputs.artifact-id }}");
    expect(outputs["artifact-digest"]?.value).toBe("${{ jobs.pack.outputs.artifact-digest }}");
  });

  it.each([
    { file: "edge.yml", id: "attest", last: usesAction("actions/attest") },
    { file: "release.yml", id: "publish", last: (step: Step) => (step.run ?? "").includes("publish.mjs") },
  ])(
    "$file's $id takes pack's artifact by its id and checks its sha256 against pack's digest before it attests or publishes",
    async ({ file, id, last }) => {
      const steps = job(await workflow(file), id).steps ?? [];
      const download = stepIndex(steps, usesAction("actions/download-artifact"));
      const check = stepIndex(steps, (step) => step.env?.ARTIFACT_DIGEST === "${{ needs.build.outputs.artifact-digest }}");
      const first = stepIndex(steps, last);

      expect(steps[download]?.with).toEqual({
        "artifact-ids": "${{ needs.build.outputs.artifact-id }}",
        path: "artifact",
        "skip-decompress": true,
        "digest-mismatch": "error",
      });
      expect(steps[check]?.run).toMatch(/sha256sum "\$\{zips\[0\]\}"/);
      expect(steps[check]?.run).toContain('"$ARTIFACT_DIGEST"');
      expect(download).toBeGreaterThanOrEqual(0);
      expect(check).toBeGreaterThan(download);
      expect(first).toBeGreaterThan(check);
    },
  );

  it.each([
    ...ownerPathExamples(["docs", "docs/notes", "packages/node"]).map(([, file]) => file),
    "docs/SPEC.md",
    "docs/img/flow.png",
    "README.md",
    "LICENSE",
    "packages/core/README.md",
    "package.json",
  ])("edge builds every push to main that change detection calls code, and only those (%s)", async (file) => {
    const edge = await workflow("edge.yml");
    const paths = (edge.on.push as { paths: string[] }).paths;

    expect(pathsFilterRuns(paths, file)).toBe(classifyChanges([file], { listed: 1, expected: 1, ownerPaths: ownerPaths.paths }).code);
  });
});
