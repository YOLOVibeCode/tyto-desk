import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyChanges, pullRequestChanges } from "../../scripts/delivery/lib/ci-changes.mjs";
import { fakeGh, ok } from "./fake-gh.ts";
import { repo, runScript } from "./helpers.ts";
import { ownerPathExamples, ownerPaths } from "./owner-paths.ts";

const ciChanges = join(repo, "scripts/delivery/ci-changes.mjs");
const OWNER_PATHS = ownerPaths.paths;

describe("change detection", () => {
  it.each([
    [["docs/SPEC.md"]],
    [["docs/IMPLEMENTATION.md", "docs/checklist-results/run-b.json", "docs/img/flow.png"]],
    [["README.md", "LICENSE"]],
    [["CONTRIBUTING.md", "docs/RELEASING.md"]],
  ])("change detection calls a PR docs-only only when it touches nothing but docs/, root Markdown and LICENSE, and no owner-merge path (%j)", (files) => {
    expect(classifyChanges(files, { listed: files.length, expected: files.length, ownerPaths: OWNER_PATHS })).toEqual({ code: false });
  });

  it.each([
    "scripts/delivery/ci-changes.mjs",
    ".github/workflows/ci.yml",
    "package.json",
    "package-lock.json",
    "packages/core/package.json",
    "CLAUDE.md",
    "AGENTS.md",
    "claude.md",
    ".claude/rules/tdd-isp.md",
    ".cursor/rules/agent-playbook.mdc",
    "packages/core/README.md",
    "LICENSE.txt",
    "docs",
    "README.MD",
  ])("change detection calls a PR that changes ci-changes.mjs, a workflow, a package file or an agent rule code (%s)", (file) => {
    expect(classifyChanges(["docs/SPEC.md", file], { listed: 2, expected: 2, ownerPaths: OWNER_PATHS }).code).toBe(true);
  });

  it.each([
    ...ownerPathExamples(["docs", "docs/notes"]),
    ["**/CLAUDE.md", "docs/claude.md"],
    ["docs/CONTRIBUTING.md", "docs/CONTRIBUTING.md"],
  ])("change detection never calls an owner-merge path docs-only (%s: %s)", (_pattern, file) => {
    expect(classifyChanges(["docs/SPEC.md", file], { listed: 2, expected: 2, ownerPaths: OWNER_PATHS }).code).toBe(true);
  });

  it.each([
    { label: "3,000 of 3,001 files", files: ["docs/SPEC.md"], listed: 3000, expected: 3001 },
    { label: "no files", files: [], listed: 0, expected: 0 },
  ])("change detection calls a PR code when the API listed fewer files than it changes, or none ($label)", ({ files, listed, expected }) => {
    expect(classifyChanges(files, { listed, expected, ownerPaths: OWNER_PATHS }).code).toBe(true);
  });

  const HEAD = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";

  /** The pull request (#42) through the API: its files as pages, then its head commit and how many files it changes. */
  function pullRequest(pages: object[][], head: { sha: string; changedFiles: number }) {
    return fakeGh([
      {
        match: /^api --method GET --paginate --slurp repos\/YOLOVibeCode\/tyto-desk\/pulls\/42\/files\?per_page=100$/,
        reply: () => ok(pages),
      },
      {
        match: /^api --method GET repos\/YOLOVibeCode\/tyto-desk\/pulls\/42$/,
        reply: () => ok({ number: 42, head: { sha: head.sha }, changed_files: head.changedFiles }),
      },
    ]);
  }

  it("change detection reads a pull request's files, renames under both names, through the API", async () => {
    const { gh, calls } = pullRequest(
      [[{ filename: "docs/moved.md", previous_filename: "scripts/delivery/ci-changes.mjs" }], [{ filename: "README.md" }]],
      { sha: HEAD, changedFiles: 2 },
    );

    const changes = await pullRequestChanges(gh, { repository: "YOLOVibeCode/tyto-desk", number: 42, headSha: HEAD, ownerPaths: OWNER_PATHS });

    expect(changes).toEqual({ code: true });
    expect(calls.map((call) => call.args.at(-1))).toEqual([
      "repos/YOLOVibeCode/tyto-desk/pulls/42/files?per_page=100",
      "repos/YOLOVibeCode/tyto-desk/pulls/42",
    ]);
  });

  it("change detection calls a docs-only PR docs-only when its head is still the event's", async () => {
    const { gh } = pullRequest([[{ filename: "docs/SPEC.md" }]], { sha: HEAD, changedFiles: 1 });

    expect(await pullRequestChanges(gh, { repository: "YOLOVibeCode/tyto-desk", number: 42, headSha: HEAD, ownerPaths: OWNER_PATHS })).toEqual({ code: false });
  });

  it.each([
    { label: "a push moved its head after the event", headSha: HEAD, apiHead: "1".repeat(40) },
    { label: "the event named no head commit", headSha: null, apiHead: HEAD },
  ])("change detection calls a PR code when the files it read may not be the event's head commit's ($label)", async ({ headSha, apiHead }) => {
    const { gh } = pullRequest([[{ filename: "docs/SPEC.md" }]], { sha: apiHead, changedFiles: 1 });

    expect(await pullRequestChanges(gh, { repository: "YOLOVibeCode/tyto-desk", number: 42, headSha, ownerPaths: OWNER_PATHS })).toEqual({ code: true });
  });

  it("change detection calls every push to main code, without reading anything", async () => {
    const output = join(await mkdtemp(join(tmpdir(), "changes-")), "output");
    await writeFile(output, "");

    const result = await runScript(ciChanges, [], {
      env: { PATH: process.env.PATH ?? "", GITHUB_EVENT_NAME: "push", GITHUB_OUTPUT: output },
    });

    expect(result.code).toBe(0);
    expect(await readFile(output, "utf8")).toBe("code=true\n");
  });
});
