import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyChanges, pullRequestChanges } from "../../scripts/delivery/lib/ci-changes.mjs";
import { fakeGh, ok } from "./fake-gh.ts";
import { repo, runScript } from "./helpers.ts";

const ciChanges = join(repo, "scripts/delivery/ci-changes.mjs");

describe("change detection", () => {
  it.each([
    [["docs/SPEC.md"]],
    [["docs/IMPLEMENTATION.md", "docs/checklist-results/run-b.json", "docs/img/flow.png"]],
    [["README.md", "LICENSE"]],
    [["CONTRIBUTING.md", "docs/RELEASING.md"]],
  ])("change detection calls a PR docs-only only when it touches nothing but docs/, root Markdown other than CLAUDE.md and AGENTS.md, and LICENSE (%j)", (files) => {
    expect(classifyChanges(files, { listed: files.length, expected: files.length })).toEqual({ code: false });
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
    expect(classifyChanges(["docs/SPEC.md", file], { listed: 2, expected: 2 }).code).toBe(true);
  });

  it("change detection calls a PR code when the API listed fewer files than it changes, or none", () => {
    expect(classifyChanges(["docs/SPEC.md"], { listed: 3000, expected: 3001 }).code).toBe(true);
    expect(classifyChanges([], { listed: 0, expected: 0 }).code).toBe(true);
  });

  it("change detection reads a pull request's files, renames under both names, through the API", async () => {
    const { gh, calls } = fakeGh([
      {
        match: /^api --method GET --paginate --slurp repos\/YOLOVibeCode\/tyto-desk\/pulls\/42\/files\?per_page=100$/,
        reply: () =>
          ok([[{ filename: "docs/moved.md", previous_filename: "scripts/delivery/ci-changes.mjs" }], [{ filename: "README.md" }]]),
      },
    ]);

    const changes = await pullRequestChanges(gh, { repository: "YOLOVibeCode/tyto-desk", number: 42, changedFiles: 2 });

    expect(changes).toEqual({ code: true });
    expect(calls).toHaveLength(1);
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
