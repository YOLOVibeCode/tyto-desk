import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { DESK_COMPAT } from "../../packages/core/src/index.ts";
import { dirtyFiles, gitRunner, tagOnMain } from "../../scripts/delivery/lib/git-facts.mjs";
import { gatherBuildFacts } from "../../scripts/delivery/lib/stamp.mjs";
import { fixture, git, gitCheckout, gitEnv, repo, runScript, tempTree } from "./helpers.ts";
import { nodePinJson } from "../fixtures/node-pin.ts";

const stamp = join(repo, "scripts/delivery/stamp.mjs");
const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const now = () => new Date("2026-10-06T18:00:00.250Z");

const project = {
  "package.json": `${JSON.stringify({ name: "x", version: "0.3.0" })}\n`,
  ".nvmrc": "26.10.0\n",
  "scripts/delivery/node-runtime.json": nodePinJson("26.10.0"),
  ".gitignore": "dist/\nnode_modules/\n",
  "a.txt": "a\n",
};

/** A runner for the stub git, which logs its argv to the returned file. */
async function stubGit(vars: Record<string, string>) {
  const log = join(await mkdtemp(join(tmpdir(), "fake-git-")), "argv.log");
  const runner = gitRunner({
    cwd: tmpdir(),
    env: { ...gitEnv, FAKE_GIT_LOG: log, ...vars },
    command: [process.execPath, fixture("fake-git.mjs")],
  });
  const calls = async (): Promise<string[][]> =>
    existsSync(log)
      ? (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
      : [];
  return { runner, calls };
}

async function eventFile(payload: unknown): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "event-")), "event.json");
  await writeFile(path, JSON.stringify(payload));
  return path;
}

const ci = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "YOLOVibeCode/tyto-desk", GITHUB_RUN_NUMBER: "57" };

describe("the stamp", () => {
  it("the stamp writes version.json into the build output and never into the repo", async () => {
    const { root, head } = await gitCheckout(project, "slice-1c/walking-skeleton");

    const result = await runScript(stamp, [], { cwd: root });

    expect(result.code).toBe(0);
    const file = JSON.parse(await readFile(join(root, "dist", "version.json"), "utf8"));
    expect(file).toEqual({
      version: `0.3.1-dev.slice-1c-walking-skeleton+${head.slice(0, 7)}`,
      channel: "dev",
      branch: "slice-1c/walking-skeleton",
      commit: head,
      dirty: false,
      builtAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
      node: "26.10.0",
      compat: DESK_COMPAT,
    });
    expect(await git(root, ["status", "--porcelain"])).toBe("");

    const outside = await mkdtemp(join(tmpdir(), "out-"));
    expect((await runScript(stamp, ["--out", outside], { cwd: root })).code).toBe(0);
    expect(existsSync(join(outside, "version.json"))).toBe(true);
  });

  it("the stamp names Desk Terminal's pinned Node, from scripts/delivery/node-runtime.json", async () => {
    const pinned = { ...project, "scripts/delivery/node-runtime.json": nodePinJson("26.11.1") };
    const { root } = await gitCheckout(pinned, "slice-1c/walking-skeleton");

    expect((await runScript(stamp, [], { cwd: root })).code).toBe(0);
    expect(JSON.parse(await readFile(join(root, "dist", "version.json"), "utf8")).node).toBe("26.11.1");
  });

  it.each(["not json", `${JSON.stringify({ version: "26.10.0", platforms: {} })}\n`])("the stamp refuses a Node pin it cannot trust in one line, exits 65 and writes nothing (%j)", async (pin) => {
    const { root } = await gitCheckout({ ...project, "scripts/delivery/node-runtime.json": pin }, "slice-1c/walking-skeleton");

    const refused = await runScript(stamp, [], { cwd: root });

    expect(refused.code).toBe(65);
    expect(refused.stderr.trim().split("\n")).toEqual([expect.stringMatching(/^stamp: the Node pin is refused \(.+\); nothing was written$/)]);
    expect(existsSync(join(root, "dist", "version.json"))).toBe(false);
  });

  it("a refused build with a refused Node pin names every refusal, the pin's among them", async () => {
    const bad = { ...project, "package.json": JSON.stringify({ version: "0.3" }), "scripts/delivery/node-runtime.json": "not json" };
    const { root } = await gitCheckout(bad);
    const env = { ...gitEnv, ...ci, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v0.3", GITHUB_REF_TYPE: "tag", PATH: process.env.PATH ?? "", GIT_TERMINAL_PROMPT: "0" };

    const result = await runScript(stamp, ["--plan"], { cwd: root, env });

    expect(result.code).toBe(65);
    expect(result.stderr).toContain("tag-not-semver");
    expect(result.stderr).toContain("node-pin: node-runtime.json is not JSON");
  });

  it("a --out inside the repo is refused with 64 even when the Node pin is refused too", async () => {
    const { root } = await gitCheckout({ ...project, "scripts/delivery/node-runtime.json": "not json" }, "slice-1c/walking-skeleton");

    const result = await runScript(stamp, ["--out", "."], { cwd: root });

    expect(result.code).toBe(64);
    expect(result.stderr).toContain("never into the repository");
  });

  it("the plan on a refused Node pin writes nothing to GITHUB_OUTPUT", async () => {
    const { root } = await gitCheckout({ ...project, "scripts/delivery/node-runtime.json": "not json" });
    const output = join(await mkdtemp(join(tmpdir(), "output-")), "github-output");
    await writeFile(output, "");
    const env = { ...gitEnv, ...ci, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_REF_TYPE: "branch", GITHUB_OUTPUT: output };

    const result = await runScript(stamp, ["--plan", "--expect-channel", "edge"], { cwd: root, env });

    expect(result.code).toBe(65);
    expect(result.stderr).toContain("the Node pin is refused");
    expect(await readFile(output, "utf8")).toBe("");
  });

  it.each([".", "..cache", "packages/x"])(
    "the stamp writes version.json into the build output and never into the repo (refuses --out %s)",
    async (out) => {
      const { root } = await gitCheckout(project);

      const intoRepo = await runScript(stamp, ["--out", out], { cwd: root });

      expect(intoRepo.code).toBe(64);
      expect(intoRepo.stderr).toContain("never into the repository");
      expect(existsSync(join(root, out, "version.json"))).toBe(false);
    },
  );

  it("the stamp fetches main and decides tagOnMain with merge-base --is-ancestor, and any git error means not on main", async () => {
    const fetch = ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"];
    const ancestor = ["merge-base", "--is-ancestor", sha, "origin/main"];

    const onMain = await stubGit({ FAKE_GIT_ANCESTOR_EXIT: "0" });
    expect(await tagOnMain(onMain.runner, sha)).toBe(true);
    expect(await onMain.calls()).toEqual([fetch, ancestor]);

    const offMain = await stubGit({ FAKE_GIT_ANCESTOR_EXIT: "1" });
    expect(await tagOnMain(offMain.runner, sha)).toBe(false);

    const fetchFails = await stubGit({ FAKE_GIT_FETCH_EXIT: "128" });
    expect(await tagOnMain(fetchFails.runner, sha)).toBe(false);
    expect(await fetchFails.calls()).toEqual([fetch]);

    const mergeBaseFails = await stubGit({ FAKE_GIT_ANCESTOR_EXIT: "128" });
    expect(await tagOnMain(mergeBaseFails.runner, sha)).toBe(false);

    const missingGit = gitRunner({ cwd: tmpdir(), env: gitEnv, command: [join(tmpdir(), "no-such-git")] });
    expect(await tagOnMain(missingGit, sha)).toBe(false);
  });

  it("the stamp takes a pull request's head commit, branch and fork flag from the event", async () => {
    const { root, head } = await gitCheckout(project, "detached-work");
    const pullRequest = (headSha: string, fullName: string | null) => ({
      pull_request: {
        number: 42,
        head: { sha: headSha, ref: "slice-1c/walking-skeleton", repo: fullName === null ? null : { full_name: fullName } },
      },
    });
    const env = async (payload: unknown) => ({
      ...gitEnv,
      ...ci,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REF: "refs/pull/42/merge",
      GITHUB_REF_TYPE: "branch",
      GITHUB_RUN_NUMBER: "118",
      GITHUB_EVENT_PATH: await eventFile(payload),
    });
    const facts = async (payload: unknown) =>
      gatherBuildFacts({
        root,
        env: await env(payload),
        git: gitRunner({ cwd: root, env: gitEnv }),
        now,
        allowDirty: false,
        dryRun: false,
      });

    const fork = await facts(pullRequest(head, "someone/tyto-desk"));
    expect(fork.problems).toEqual([]);
    expect(fork.input).toMatchObject({
      event: "pull_request",
      sha: head,
      branch: "slice-1c/walking-skeleton",
      headRepoIsFork: true,
      prNumber: 42,
      runNumber: 118,
    });

    const same = await facts(pullRequest(head, "YOLOVibeCode/tyto-desk"));
    expect(same.input.headRepoIsFork).toBe(false);

    const deletedFork = await facts(pullRequest(head, null));
    expect(deletedFork.input.headRepoIsFork).toBe(true);

    const elsewhere = await facts(pullRequest(sha, "YOLOVibeCode/tyto-desk"));
    expect(elsewhere.problems).toEqual([`the checkout is ${head}, not the pull request's head commit ${sha}`]);
  });

  it("a tag build records branch main only when the tag is on main", async () => {
    const { root } = await gitCheckout(project);
    const env = { ...gitEnv, ...ci, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v0.3.0", GITHUB_REF_TYPE: "tag" };
    const facts = async (ancestorExit: string) =>
      gatherBuildFacts({
        root,
        env,
        git: (await stubGit({ FAKE_GIT_HEAD: sha, FAKE_GIT_ANCESTOR_EXIT: ancestorExit })).runner,
        now,
        allowDirty: false,
        dryRun: false,
      });

    expect((await facts("0")).input).toMatchObject({ tagOnMain: true, branch: "main", sha });
    expect((await facts("1")).input).toMatchObject({ tagOnMain: false, branch: null, sha });
  });

  it("dirty means tracked changes or untracked files that are not ignored, and CI fails naming them", async () => {
    const { root } = await gitCheckout(project);
    const runner = gitRunner({ cwd: root, env: gitEnv });
    expect(await dirtyFiles(runner)).toEqual([]);

    await writeFile(join(root, "dist-not-ignored.txt"), "new\n");
    await appendFile(join(root, "a.txt"), "changed\n");
    await git(root, ["rm", "-q", "--cached", ".nvmrc"]);
    await writeFile(join(root, "node_modules.txt"), "x\n");
    await git(root, ["add", "node_modules.txt"]);
    await writeFile(join(root, ".gitignore"), "dist/\nnode_modules/\n");
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist", "ignored.txt"), "ignored\n");

    expect(await dirtyFiles(runner)).toEqual([".nvmrc", "a.txt", "dist-not-ignored.txt", "node_modules.txt"]);

    const result = await runScript(stamp, [], {
      cwd: root,
      env: { ...gitEnv, ...ci, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_REF_TYPE: "branch" },
    });
    expect(result.code).toBe(65);
    expect(result.stderr).toContain("dirty-tree");
    for (const file of [".nvmrc", "a.txt", "dist-not-ignored.txt", "node_modules.txt"]) {
      expect(result.stderr).toContain(`  ${file}`);
    }
    expect(result.stderr).not.toContain("dist/ignored.txt");
    expect(existsSync(join(root, "dist", "version.json"))).toBe(false);
  });

  it.each([
    { label: "git status fails", vars: { FAKE_GIT_STATUS_EXIT: "128" } },
    { label: "git ls-files fails", vars: { FAKE_GIT_LS_FILES_EXIT: "128" } },
  ])("the stamp counts a tree as dirty when git cannot list its changes ($label)", async ({ vars }) => {
    const { runner } = await stubGit({ FAKE_GIT_HEAD: sha, FAKE_GIT_BRANCH: "slice-1c/walking-skeleton", ...vars });
    const root = await tempTree("project-", project);

    const facts = await gatherBuildFacts({ root, env: gitEnv, git: runner, now, allowDirty: false, dryRun: false });

    expect(facts.dirtyFiles).toBeNull();
    expect(facts.input.dirty).toBe(true);
  });

  it("the stamp refuses a tree whose changes git cannot list, and says so", async () => {
    const root = await tempTree("project-", project);
    const bin = await mkdtemp(join(tmpdir(), "bin-"));
    // `git` on PATH is the stub, with its answers built in: the stamp gives git only an allowlisted environment.
    const shim = [
      "#!/usr/bin/env node",
      `process.env.FAKE_GIT_HEAD = ${JSON.stringify(sha)};`,
      'process.env.FAKE_GIT_BRANCH = "slice-1c/walking-skeleton";',
      'process.env.FAKE_GIT_STATUS_EXIT = "128";',
      `await import(${JSON.stringify(pathToFileURL(fixture("fake-git.mjs")).href)});`,
      "",
    ].join("\n");
    await writeFile(join(bin, "git"), shim, { mode: 0o755 });

    const result = await runScript(stamp, [], { cwd: root, env: { ...gitEnv, PATH: `${bin}${delimiter}${dirname(process.execPath)}` } });

    expect(result.code).toBe(65);
    expect(result.stderr).toContain("dirty-tree");
    expect(result.stderr).toContain("git could not list the changes");
    expect(existsSync(join(root, "dist", "version.json"))).toBe(false);
  });

  it("the stamp reports version, channel, publish and live to the workflow, and its plan mode writes nothing", async () => {
    const { root, head } = await gitCheckout(project);
    const output = join(await mkdtemp(join(tmpdir(), "output-")), "github-output");
    await writeFile(output, "");
    const env = {
      ...gitEnv,
      ...ci,
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
      GITHUB_REF_TYPE: "branch",
      GITHUB_OUTPUT: output,
    };

    const result = await runScript(stamp, ["--plan", "--expect-channel", "edge"], { cwd: root, env });

    expect(result.code).toBe(0);
    const version = `0.3.1-edge.57+${head.slice(0, 7)}`;
    expect(await readFile(output, "utf8")).toBe(
      `version=${version}\nchannel=edge\npublish=attested-artifact\nlive=off\nlabel=v${version}\n`,
    );
    expect(existsSync(join(root, "dist"))).toBe(false);
  });

  it("the stamp refuses a build whose channel is not the one the workflow asked for", async () => {
    const { root } = await gitCheckout(project);
    const env = { ...gitEnv, ...ci, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_REF_TYPE: "branch" };

    const result = await runScript(stamp, ["--expect-channel", "stable"], { cwd: root, env });

    expect(result.code).toBe(65);
    expect(result.stderr).toContain("expected a stable build, but this is an edge build");
    expect(existsSync(join(root, "dist", "version.json"))).toBe(false);
  });

  it("the stamp names each refusal and exits 65", async () => {
    const { root } = await gitCheckout({ ...project, "package.json": JSON.stringify({ version: "0.3" }) });
    const env = { ...gitEnv, ...ci, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v0.3", GITHUB_REF_TYPE: "tag" };
    const unreachable = { ...env, PATH: process.env.PATH ?? "", GIT_TERMINAL_PROMPT: "0" };

    const result = await runScript(stamp, ["--plan"], { cwd: root, env: unreachable });

    expect(result.code).toBe(65);
    for (const refusal of ["tag-not-semver", "tag-not-on-main", "bad-base-version"]) {
      expect(result.stderr).toContain(refusal);
    }
  });
});
