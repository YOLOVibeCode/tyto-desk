import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ownerMerge, ownerMergeDecision } from "../../scripts/delivery/lib/owner-merge.mjs";
import { readOwnerPaths } from "../../scripts/delivery/lib/owner-paths.mjs";
import { RELEASE_BRANCH } from "../../scripts/delivery/lib/release-branch.mjs";
import { fakeGh, ok, type GhCall } from "./fake-gh.ts";
import { ownerPathExamples, ownerPaths as config } from "./owner-paths.ts";

const REPOSITORY = "YOLOVibeCode/tyto-desk";

/** A file under each owner-merge path, a nested one too for the paths that count at any depth. */
const examples = ownerPathExamples(["packages/node/test", "docs/notes"]);

/** The pull request as the API reports it; `changed_files` defaults to the number of files listed. */
type Pull = { auto_merge: object | null; labels: { name: string }[]; changed_files?: number | null };

/** gh against one pull request (#7) with `files`, its state, and the comments already on it. */
function github(files: string[], pull: Pull, comments: { user: { login: string }; body: string }[] = [], failLabel = false) {
  return fakeGh([
    { match: /^api --method GET --paginate --slurp repos\/[^ ]+\/pulls\/7\/files/, reply: () => ok([files.map((filename) => ({ filename }))]) },
    { match: /^api --method GET repos\/[^ ]+\/pulls\/7$/, reply: () => ok({ changed_files: files.length, ...pull }) },
    { match: /^api --method GET --paginate --slurp repos\/[^ ]+\/issues\/7\/comments/, reply: () => ok([comments]) },
    {
      match: /^api --method POST repos\/[^ ]+\/issues\/7\/labels --input -$/,
      reply: () => (failLabel ? { code: 1, stdout: "", stderr: "gh: Server Error (HTTP 500)\n" } : ok([{ name: "owner-merge" }])),
    },
    { match: /^api --method DELETE repos\/[^ ]+\/issues\/7\/labels\/owner-merge$/, reply: () => ok("") },
    { match: /^api --method POST repos\/[^ ]+\/issues\/7\/comments --input -$/, reply: () => ok({ id: 1 }) },
    { match: /^pr merge 7 --repo [^ ]+ --disable-auto$/, reply: () => ok("") },
  ]);
}

const writes = (calls: GhCall[]) =>
  calls.filter((call) => call.args.includes("POST") || call.args.includes("DELETE") || call.args[0] === "pr").map((call) => call.args.join(" "));

const OWNER_MERGE_WRITES = [
  `pr merge 7 --repo ${REPOSITORY} --disable-auto`,
  `api --method POST repos/${REPOSITORY}/issues/7/labels --input -`,
  `api --method POST repos/${REPOSITORY}/issues/7/comments --input -`,
];

const commentOf = (calls: GhCall[]) =>
  (JSON.parse(calls.find((call) => call.args.join(" ").endsWith("/comments --input -"))?.input ?? "{}") as { body?: string }).body ?? "";

describe("owner-merge", () => {
  it.each([...examples, ["the release PR's branch", "CHANGELOG.md"]])(
    "owner-merge labels a PR that touches %s and turns its auto-merge off",
    async (pattern, file) => {
      const headRef = pattern === "the release PR's branch" ? RELEASE_BRANCH : "feat/x";
      const { gh, calls } = github(["packages/node/src/x.ts", file], { auto_merge: { merge_method: "squash" }, labels: [] });

      await ownerMerge(gh, { repository: REPOSITORY, number: 7, headRef, config });

      expect(writes(calls)).toEqual(OWNER_MERGE_WRITES);
      expect(JSON.parse(calls.find((call) => call.args.join(" ").includes("/labels --input"))?.input ?? "{}")).toEqual({
        labels: ["owner-merge"],
      });
    },
  );

  it("owner-merge removes its label when no owner-merge path remains", async () => {
    const { gh, calls } = github(["packages/node/src/x.ts", "docs/SPEC.md"], {
      auto_merge: { merge_method: "squash" },
      labels: [{ name: "owner-merge" }, { name: "live" }],
    });

    await ownerMerge(gh, { repository: REPOSITORY, number: 7, headRef: "feat/x", config });

    expect(writes(calls)).toEqual([`api --method DELETE repos/${REPOSITORY}/issues/7/labels/owner-merge`]);
  });

  it("owner-merge comments once and leaves auto-merge alone when it is already off", async () => {
    const earlier = { user: { login: "github-actions[bot]" }, body: "Owner merge.\n\n<!-- desk:owner-merge -->" };
    const { gh, calls } = github([".github/workflows/ci.yml"], { auto_merge: null, labels: [{ name: "owner-merge" }] }, [earlier]);

    await ownerMerge(gh, { repository: REPOSITORY, number: 7, headRef: "feat/x", config });

    expect(writes(calls)).toEqual([`api --method POST repos/${REPOSITORY}/issues/7/labels --input -`]);
  });

  it("owner-merge's comment says the owner merges the PR, or the session acting for them once every check is green on its head commit and two independent security reviews approved that commit", async () => {
    const { gh, calls } = github([".github/workflows/ci.yml"], { auto_merge: null, labels: [] });

    await ownerMerge(gh, { repository: REPOSITORY, number: 7, headRef: "feat/x", config });

    const body = commentOf(calls);
    expect(body).toContain("every check is green on its head commit");
    expect(body).toContain("two independent security-review agents");
    expect(body).toContain("any REFUSE blocks it");
    expect(body).not.toContain("never merge it");
  });

  it("owner-merge's comment on the release PR says only the owner marks it ready and merges it", async () => {
    const { gh, calls } = github(["CHANGELOG.md", ".release-please-manifest.json"], { auto_merge: null, labels: [] });

    await ownerMerge(gh, { repository: REPOSITORY, number: 7, headRef: RELEASE_BRANCH, config });

    const body = commentOf(calls);
    expect(body).toContain("only the owner marks it ready and merges it");
    expect(body).not.toContain("security-review agents");
  });

  it("owner-merge does not trust a marker that someone else wrote", async () => {
    const forged = { user: { login: "someone" }, body: "<!-- desk:owner-merge -->" };
    const { gh, calls } = github([".npmrc"], { auto_merge: null, labels: [] }, [forged]);

    await ownerMerge(gh, { repository: REPOSITORY, number: 7, headRef: "feat/x", config });

    expect(writes(calls)).toContain(`api --method POST repos/${REPOSITORY}/issues/7/comments --input -`);
  });

  it.each([
    { files: ["claude.md"], ownerMerge: true },
    { files: [".GitHub/workflows/x.yml"], ownerMerge: true },
    { files: ["Packages/Core/src/Release/latest.ts"], ownerMerge: true },
    { files: ["scripts/lib/build.mjs", "docs/x.md"], ownerMerge: false },
  ])("owner-merge matches owner-merge paths without case ($files)", ({ files, ownerMerge: expected }) => {
    expect(ownerMergeDecision({ files, headRef: "feat/x", config }).ownerMerge).toBe(expected);
  });

  it.each([
    "packages/node/CLAUDE.md",
    "docs/CLAUDE.md",
    "packages/core/src/AGENTS.md",
    "docs/agents.md",
    "CLAUDE.local.md",
    "packages/node/CLAUDE.local.md",
    ".cursorrules",
    "packages/core/.cursorrules",
    ".mcp.json",
    "docs/.mcp.json",
    "packages/node/.claude/settings.json",
    "packages/core/.cursor/rules/core.mdc",
    "docs/CONTRIBUTING.md",
    "docs/contributing.md",
  ])(
    "owner-merge treats CLAUDE.md, AGENTS.md and the other agent rules at any depth, CLAUDE.local.md, .cursorrules, .mcp.json and docs/CONTRIBUTING.md as owner-merge paths (%s)",
    (file) => {
      expect(ownerMergeDecision({ files: [file], headRef: "feat/x", config }).ownerMerge).toBe(true);
    },
  );

  it.each(["CONTRIBUTING.md", "docs/RELEASING.md", "docs/CLAUDE.md.txt", "packages/node/NOTCLAUDE.md", "docs/claude/notes.md", ".mcp.json.example"])(
    "owner-merge leaves a file that only resembles an agent rule alone (%s)",
    (file) => {
      expect(ownerMergeDecision({ files: [file], headRef: "feat/x", config }).ownerMerge).toBe(false);
    },
  );

  it("the delivery scripts read owner-paths.json from beside them", async () => {
    expect(await readOwnerPaths()).toEqual({ paths: config.paths, branches: config.branches });
  });

  it.each([
    { label: "no paths", text: JSON.stringify({ paths: [], branches: [] }) },
    { label: "a path that is not text", text: JSON.stringify({ paths: [".github/**", 7], branches: [] }) },
    { label: "no branches", text: JSON.stringify({ paths: [".github/**"] }) },
    { label: "not JSON", text: "{ paths" },
  ])("the delivery scripts refuse an owner-paths.json they cannot trust ($label)", async ({ text }) => {
    const file = join(await mkdtemp(join(tmpdir(), "owner-paths-")), "owner-paths.json");
    await writeFile(file, text);

    await expect(readOwnerPaths(pathToFileURL(file))).rejects.toThrow(/owner-paths/);
  });

  it("owner-paths.json spells each path as exact names and whole ** segments", () => {
    for (const pattern of config.paths) {
      for (const segment of pattern.split("/")) {
        expect(segment === "**" || (segment !== "" && !segment.includes("*")), `${pattern}`).toBe(true);
      }
    }
  });

  const docs = Array.from({ length: 3000 }, (_, i) => `docs/notes/${String(i).padStart(4, "0")}.md`);
  it.each([
    { label: "3,000 of 3,001 files listed", files: docs, changedFiles: 3001, reason: "the API listed only 3000 of 3001 files" },
    { label: "no files listed", files: [], changedFiles: 0, reason: "the API listed no files" },
    { label: "no count of changed files", files: ["docs/SPEC.md"], changedFiles: null, reason: "the API did not say how many files the pull request changes" },
  ])(
    "owner-merge treats a PR whose files the API did not list in full as owner-merge ($label)",
    async ({ files, changedFiles, reason }) => {
      const { gh, calls } = github(files, { auto_merge: { merge_method: "squash" }, labels: [], changed_files: changedFiles });

      const result = await ownerMerge(gh, { repository: REPOSITORY, number: 7, headRef: "docs/x", config });

      expect(result.reasons).toEqual([reason]);
      expect(writes(calls)).toEqual(OWNER_MERGE_WRITES);
      expect(commentOf(calls)).toContain(reason);
    },
  );

  it("owner-merge turns auto-merge off before it labels, so a failed label call leaves auto-merge off", async () => {
    const { gh, calls } = github(["scripts/delivery/x.mjs"], { auto_merge: { merge_method: "squash" }, labels: [] }, [], true);

    await expect(ownerMerge(gh, { repository: REPOSITORY, number: 7, headRef: "feat/x", config })).rejects.toThrow(/HTTP 500/);

    expect(writes(calls)).toEqual(OWNER_MERGE_WRITES.slice(0, 2));
  });
});
