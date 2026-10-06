import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ownerMerge, ownerMergeDecision } from "../../scripts/delivery/lib/owner-merge.mjs";
import { fakeGh, ok, type GhCall } from "./fake-gh.ts";
import { repo } from "./helpers.ts";

const REPOSITORY = "YOLOVibeCode/tyto-desk";
const config = JSON.parse(await readFile(join(repo, "scripts/delivery/owner-paths.json"), "utf8")) as {
  paths: string[];
  branches: string[];
};

/** A file under each owner-merge path: `dir/**` gets a file inside it. */
const examples = config.paths.map((pattern) => [pattern, pattern.endsWith("/**") ? `${pattern.slice(0, -3)}/example.txt` : pattern]);

type Pull = { auto_merge: object | null; labels: { name: string }[] };

/** gh against one pull request (#7) with `files`, its state, and the comments already on it. */
function github(files: string[], pull: Pull, comments: { user: { login: string }; body: string }[] = []) {
  return fakeGh([
    { match: /^api --method GET --paginate --slurp repos\/[^ ]+\/pulls\/7\/files/, reply: () => ok([files.map((filename) => ({ filename }))]) },
    { match: /^api --method GET repos\/[^ ]+\/pulls\/7$/, reply: () => ok(pull) },
    { match: /^api --method GET --paginate --slurp repos\/[^ ]+\/issues\/7\/comments/, reply: () => ok([comments]) },
    { match: /^api --method POST repos\/[^ ]+\/issues\/7\/labels --input -$/, reply: () => ok([{ name: "owner-merge" }]) },
    { match: /^api --method DELETE repos\/[^ ]+\/issues\/7\/labels\/owner-merge$/, reply: () => ok("") },
    { match: /^api --method POST repos\/[^ ]+\/issues\/7\/comments --input -$/, reply: () => ok({ id: 1 }) },
    { match: /^pr merge 7 --repo [^ ]+ --disable-auto$/, reply: () => ok("") },
  ]);
}

const writes = (calls: GhCall[]) =>
  calls.filter((call) => call.args.includes("POST") || call.args.includes("DELETE") || call.args[0] === "pr").map((call) => call.args.join(" "));

describe("owner-merge", () => {
  it.each([...examples, ["the release PR's branch", "CHANGELOG.md"]])(
    "owner-merge labels a PR that touches %s and turns its auto-merge off",
    async (pattern, file) => {
      const headRef = pattern === "the release PR's branch" ? "release-please--branches--main" : "feat/x";
      const { gh, calls } = github(["packages/core/src/x.ts", file], { auto_merge: { merge_method: "squash" }, labels: [] });

      await ownerMerge(gh, { repository: REPOSITORY, number: 7, headRef, config });

      expect(writes(calls)).toEqual([
        `api --method POST repos/${REPOSITORY}/issues/7/labels --input -`,
        `pr merge 7 --repo ${REPOSITORY} --disable-auto`,
        `api --method POST repos/${REPOSITORY}/issues/7/comments --input -`,
      ]);
      expect(JSON.parse(calls.find((call) => call.args.join(" ").includes("/labels --input"))?.input ?? "{}")).toEqual({
        labels: ["owner-merge"],
      });
    },
  );

  it("owner-merge removes its label when no owner-merge path remains", async () => {
    const { gh, calls } = github(["packages/core/src/x.ts", "docs/SPEC.md"], {
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

  it("owner-merge does not trust a marker that someone else wrote", async () => {
    const forged = { user: { login: "someone" }, body: "<!-- desk:owner-merge -->" };
    const { gh, calls } = github([".npmrc"], { auto_merge: null, labels: [] }, [forged]);

    await ownerMerge(gh, { repository: REPOSITORY, number: 7, headRef: "feat/x", config });

    expect(writes(calls)).toContain(`api --method POST repos/${REPOSITORY}/issues/7/comments --input -`);
  });

  it("owner-merge matches owner-merge paths without case", () => {
    expect(ownerMergeDecision({ files: ["claude.md"], headRef: "feat/x", config }).ownerMerge).toBe(true);
    expect(ownerMergeDecision({ files: [".GitHub/workflows/x.yml"], headRef: "feat/x", config }).ownerMerge).toBe(true);
    expect(ownerMergeDecision({ files: ["scripts/lib/build.mjs", "docs/x.md"], headRef: "feat/x", config })).toEqual({
      ownerMerge: false,
      reasons: [],
    });
  });
});
