import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { shellCommands } from "../scripts/delivery/lib/workflow-rules.mjs";
import {
  CACHE_VOLUME,
  CHROME_CACHE_DIR,
  CI_CACHE_DIR,
  CI_CONTEXT,
  MAX_DESK_CONTAINERS,
  OWNER_LABEL,
  RESOURCE_LABEL,
  RESULTS_DIR,
  RUNNER_LABEL,
  STALE_AFTER_MS,
  STARTED_LABEL,
  USERNS_LIMIT,
  canStartDeskContainer,
  chromeCacheFile,
  chromePin,
  deskContainerCap,
  depsVolumeName,
  dockerTime,
  dockerignoreText,
  doneCode,
  doneLine,
  imageTag,
  imagesToPrune,
  installInputs,
  leftoverContainers,
  phase1RunArgs,
  phase2RepoEntries,
  phase2RunArgs,
  repoPathAllowed,
  runnerArgs,
  runnerRefusal,
  suiteRefusal,
  userNamespaceRefusal,
  volumesToPrune,
} from "../scripts/lib/live.mjs";
import { readResultFile, unsafeResultEntries } from "../scripts/lib/live-results.mjs";
import liveConfig from "../vitest.live.config.ts";
import { setup as containerGuard } from "./live/setup/container-guard.ts";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("..", import.meta.url));
const GiB = 1024 ** 3;

/**
 * The argv of every child process a script starts with npm, read from its syntax tree: a call whose first argument is
 * the string "npm" (or a path ending in /npm) and whose second is an array of strings. Any other call that names npm in
 * its first argument (a shell string, an argv that is not literal) is `null`.
 */
function npmProcesses(text: string, file: string): Array<string[] | null> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found: Array<string[] | null> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const [command, argv] = node.arguments;
      if (command !== undefined && ts.isStringLiteralLike(command) && /(?:^|\/)npm(?:\s|$)/.test(command.text)) {
        const words =
          /(?:^|\/)npm$/.test(command.text) && argv !== undefined && ts.isArrayLiteralExpression(argv)
            ? argv.elements.map((element) => (ts.isStringLiteralLike(element) ? element.text : null))
            : [null];
        found.push(words.every((word) => word !== null) ? (words as string[]) : null);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const home = "/Users/alex";
const colima = { name: "colima", endpoint: "unix:///Users/alex/.colima/default/docker.sock" };
const vm = { name: "colima", osType: "linux", architecture: "aarch64", memTotal: 6_197_440_512 };
const onTheMac = {
  ci: false,
  env: {},
  platform: "darwin",
  arch: "arm64",
  home,
  homeReal: home,
  repoReal: "/Users/alex/Dev/tyto-desk",
  context: colima,
  info: vm,
};
const runnerEngine = { name: "runnervm", osType: "linux", architecture: "aarch64", memTotal: 16 * GiB };
const inActions = {
  ...onTheMac,
  ci: true,
  env: { GITHUB_ACTIONS: "true" },
  platform: "linux",
  home: "/home/runner",
  homeReal: "/home/runner",
  repoReal: "/home/runner/work/tyto-desk/tyto-desk",
  context: null,
  info: runnerEngine,
};

describe("where the live harness runs", () => {
  it.each([
    { label: "the runner on the Mac with Colima running", refusal: () => runnerRefusal(onTheMac), refused: false },
    {
      label: "the runner with Colima under COLIMA_HOME",
      refusal: () =>
        runnerRefusal({
          ...onTheMac,
          env: { COLIMA_HOME: "/Users/alex/vms" },
          context: { name: "colima", endpoint: "unix:///Users/alex/vms/default/docker.sock" },
        }),
      refused: false,
    },
    { label: "the runner without a colima context", refusal: () => runnerRefusal({ ...onTheMac, context: null }), refused: true },
    { label: "the runner while the Colima VM is stopped", refusal: () => runnerRefusal({ ...onTheMac, info: null }), refused: true },
    {
      label: "the runner with a colima context that points at Docker Desktop",
      refusal: () =>
        runnerRefusal({ ...onTheMac, context: { name: "colima", endpoint: "unix:///Users/alex/.docker/run/docker.sock" } }),
      refused: true,
    },
    {
      label: "the runner with a colima context on a TCP endpoint",
      refusal: () => runnerRefusal({ ...onTheMac, context: { name: "colima", endpoint: "tcp://10.0.0.5:2376" } }),
      refused: true,
    },
    {
      label: "the runner with a colima context that climbs out of ~/.colima",
      refusal: () =>
        runnerRefusal({ ...onTheMac, context: { name: "colima", endpoint: "unix:///Users/alex/.colima/../.docker/docker.sock" } }),
      refused: true,
    },
    {
      label: "the runner against a daemon that is not a Colima VM",
      refusal: () => runnerRefusal({ ...onTheMac, info: { ...vm, name: "docker-desktop" } }),
      refused: true,
    },
    {
      label: "the runner against an x86_64 Colima VM",
      refusal: () => runnerRefusal({ ...onTheMac, info: { ...vm, architecture: "x86_64" } }),
      refused: true,
    },
    { label: "the runner without --ci on Linux", refusal: () => runnerRefusal({ ...onTheMac, platform: "linux" }), refused: true },
    {
      label: "the runner on the Mac with a checkout outside the home directory",
      refusal: () => runnerRefusal({ ...onTheMac, repoReal: "/opt/src/tyto-desk" }),
      refused: true,
    },
    {
      label: "the runner on the Mac with a checkout in a sibling of the home directory",
      refusal: () => runnerRefusal({ ...onTheMac, repoReal: "/Users/alexander/Dev/tyto-desk" }),
      refused: true,
    },
    {
      label: "the runner with a checkout whose path holds a comma",
      refusal: () => runnerRefusal({ ...onTheMac, repoReal: "/Users/alex/Dev/a,b/tyto-desk" }),
      refused: true,
    },
    {
      label: "the runner inside the test container",
      refusal: () => runnerRefusal({ ...onTheMac, env: { DESK_IN_CONTAINER: "1" } }),
      refused: true,
    },
    { label: "the runner with --ci in GitHub Actions on linux-arm64", refusal: () => runnerRefusal(inActions), refused: false },
    { label: "the runner with --ci outside GitHub Actions", refusal: () => runnerRefusal({ ...inActions, env: {} }), refused: true },
    { label: "the runner with --ci in GitHub Actions on x64", refusal: () => runnerRefusal({ ...inActions, arch: "x64" }), refused: true },
    { label: "the runner with --ci on the Mac", refusal: () => runnerRefusal({ ...inActions, platform: "darwin" }), refused: true },
    {
      label: "the runner with --ci inside the test container",
      refusal: () => runnerRefusal({ ...inActions, env: { GITHUB_ACTIONS: "true", DESK_IN_CONTAINER: "1" } }),
      refused: true,
    },
    {
      label: "the runner with --ci against an x86_64 Docker engine",
      refusal: () => runnerRefusal({ ...inActions, info: { ...runnerEngine, architecture: "x86_64" } }),
      refused: true,
    },
    {
      label: "the runner with --ci while the runner's Docker engine is not answering",
      refusal: () => runnerRefusal({ ...inActions, info: null }),
      refused: true,
    },
    {
      label: "the runner with --ci where GITHUB_ACTIONS is not exactly true",
      refusal: () => runnerRefusal({ ...inActions, env: { GITHUB_ACTIONS: "1" } }),
      refused: true,
    },
    {
      label: "the runner with --ci against a Windows Docker engine",
      refusal: () => runnerRefusal({ ...inActions, info: { ...runnerEngine, osType: "windows" } }),
      refused: true,
    },
    {
      label: "the runner without --ci in GitHub Actions on linux-arm64",
      refusal: () => runnerRefusal({ ...inActions, ci: false }),
      refused: true,
    },
    {
      label: "the suite in the Linux test container",
      refusal: () => suiteRefusal({ platform: "linux", env: { DESK_IN_CONTAINER: "1" } }),
      refused: false,
    },
    {
      label: "the suite on the Mac",
      refusal: () => suiteRefusal({ platform: "darwin", env: { DESK_IN_CONTAINER: "1" } }),
      refused: true,
    },
    { label: "the suite on Linux outside the container", refusal: () => suiteRefusal({ platform: "linux", env: {} }), refused: true },
    {
      label: "the suite with DESK_IN_CONTAINER=true",
      refusal: () => suiteRefusal({ platform: "linux", env: { DESK_IN_CONTAINER: "true" } }),
      refused: true,
    },
  ])(
    "the live runner runs only through Colima on a Mac or the runner's Docker in GitHub Actions on linux-arm64, and the suite only inside the Linux container ($label)",
    ({ refusal, refused }) => {
      const reason = refusal();

      expect(reason !== null).toBe(refused);
      if (reason !== null) expect(reason.length).toBeGreaterThan(0);
    },
  );

  it.each([
    [[], { ci: false, vitestArgs: [] }],
    [["--ci"], { ci: true, vitestArgs: [] }],
    [["pty", "--ci", "-t", "tmux"], { ci: true, vitestArgs: ["pty", "-t", "tmux"] }],
    [["chrome"], { ci: false, vitestArgs: ["chrome"] }],
  ])("the live runner takes --ci for itself and passes everything else to vitest (%j)", (argv, expected) => {
    expect(runnerArgs(argv)).toEqual(expected);
  });

  it("the live config's first global setup is the container guard", () => {
    expect(liveConfig.test?.globalSetup).toEqual(["test/live/setup/container-guard.ts", "test/setup/global-setup.ts"]);
  });

  it("the container guard refuses wherever npm test runs, which is never the Linux test container", () => {
    expect(() => containerGuard()).toThrow(/runs only inside the Linux test container/);
  });

  it.each(["run.mjs", "install.mjs"])("the in-container harness (%s) refuses to start outside the Linux test container", async (script) => {
    const result = await run(process.execPath, [join(repo, "test", "live", "harness", script)], {
      env: { PATH: dirname(process.execPath) },
      timeout: 20_000,
    }).then(
      () => ({ code: 0, stderr: "" }),
      (err: { code?: number; stderr?: string }) => ({ code: err.code ?? -1, stderr: err.stderr ?? "" }),
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/runs only inside the Linux test container/);
  });
});

describe("the live runner's containers", () => {
  const now = Date.parse("2026-10-06T22:00:00Z");
  const ours = (runner: string, started = now - 60_000) => ({
    [OWNER_LABEL]: "1",
    [RUNNER_LABEL]: runner,
    [STARTED_LABEL]: String(started),
  });
  const alive = (pid: number) => pid === 12;

  it("the live runner removes leftover desk-live containers and nobody else's", () => {
    const containers = [
      { id: "a1", name: "desk-live-run-a1", state: "exited", labels: ours("mac:10") },
      { id: "b2", name: "desk-live-run-b2", state: "running", labels: ours("mac:11") },
      { id: "c3", name: "desk-live-run-c3", state: "running", labels: ours("mac:12") },
      // A live runner's container between docker run's create and start, and one its --rm is about to remove.
      { id: "d4", name: "desk-live-deps-d4", state: "created", labels: ours("mac:12") },
      { id: "d5", name: "desk-live-check-d5", state: "exited", labels: ours("mac:12") },
      // Docker's own --rm is already removing it.
      { id: "r6", name: "desk-live-run-r6", state: "removing", labels: ours("mac:10") },
      // Another host's runner: its pid means nothing here, so only an old, stopped container counts as left over.
      { id: "e5", name: "desk-live-run-e5", state: "running", labels: ours("other-mac:11", now - 2 * STALE_AFTER_MS) },
      { id: "e6", name: "desk-live-run-e6", state: "exited", labels: ours("other-mac:11", now - STALE_AFTER_MS - 1) },
      { id: "e7", name: "desk-live-deps-e7", state: "created", labels: ours("other-mac:11", now - 60_000) },
      { id: "f6", name: "er-postgres", state: "exited", labels: ours("mac:10") },
      { id: "g7", name: "desk-live-made-by-hand", state: "exited", labels: {} },
      { id: "h8", name: "desk-lab-smoke", state: "exited", labels: {} },
      // Made by hand from a harness image: labels an image carries reach its containers, but never a runner label.
      { id: "i9", name: "desk-live-from-the-image", state: "exited", labels: { [OWNER_LABEL]: "1", [RESOURCE_LABEL]: "1" } },
    ];

    expect(leftoverContainers(containers, { host: "mac", alive, now }).map((c) => c.name)).toEqual([
      "desk-live-run-a1",
      "desk-live-run-b2",
      "desk-live-run-e6",
    ]);
  });

  it.each([
    [6_197_440_512, 1],
    [7.4 * GiB, 1],
    [7.5 * GiB, 2],
    [16 * GiB, MAX_DESK_CONTAINERS],
    [64 * GiB, MAX_DESK_CONTAINERS],
    [2 * GiB, 1],
    [Number.NaN, 1],
  ])(
    "the live runner allows a second Desk container only when the VM's memory holds two suites and headroom (%d bytes, %i)",
    (memory, cap) => {
      expect(deskContainerCap(memory)).toBe(cap);
    },
  );

  it.each([
    [0, 2, true],
    [1, 2, true],
    [2, 2, false],
    [0, 1, true],
    [1, 1, false],
  ])("the live runner starts a container only while fewer Desk containers run than it allows (%i of %i)", (running, cap, allowed) => {
    const containers = Array.from({ length: running }, (_, i) => ({
      id: `r${i}`,
      name: `desk-live-run-r${i}`,
      state: i % 2 === 0 ? "running" : "created",
      labels: ours(`mac:${100 + i}`),
    }));
    const others = [
      { id: "x", name: "er-redis", state: "running", labels: {} },
      { id: "y", name: "desk-live-run-y", state: "exited", labels: ours("mac:99") },
    ];

    expect(canStartDeskContainer([...containers, ...others], cap)).toBe(allowed);
  });

  it("phase 1 installs dependencies into a volume keyed by every file npm ci reads", () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    const inputs = [
      { path: "package.json", bytes: bytes('{"workspaces":["packages/core"]}') },
      { path: "package-lock.json", bytes: bytes('{"lockfileVersion":3}') },
      { path: ".npmrc", bytes: bytes("ignore-scripts=true\n") },
      { path: "packages/core/package.json", bytes: bytes('{"name":"@desk/core"}') },
    ];
    const changed = (i: number) =>
      inputs.map((f, j) => (j === i ? { ...f, bytes: bytes(`${new TextDecoder().decode(f.bytes)} `) } : f));

    expect(depsVolumeName(inputs)).toMatch(/^desk-live-deps-[0-9a-f]{16}$/);
    expect(depsVolumeName([...inputs].reverse())).toBe(depsVolumeName(inputs));
    for (const i of inputs.keys()) expect(depsVolumeName(changed(i))).not.toBe(depsVolumeName(inputs));
  });

  it("phase 1 reads package.json, package-lock.json, .npmrc and each workspace's package.json", () => {
    const manifest = JSON.stringify({ workspaces: ["packages/core", "packages/node"] });

    expect(installInputs(manifest, true)).toEqual({
      ok: true,
      files: ["package.json", "package-lock.json", ".npmrc", "packages/core/package.json", "packages/node/package.json"],
      workspaces: ["packages/core", "packages/node"],
    });
    expect(installInputs(manifest, false)).toEqual({
      ok: true,
      files: ["package.json", "package-lock.json", "packages/core/package.json", "packages/node/package.json"],
      workspaces: ["packages/core", "packages/node"],
    });
  });

  it.each([["packages/*"], ["../outside"], ["packages/./core"], ["/abs"], [7]])(
    "phase 1 refuses a workspace that is not a plain relative path (%j)",
    (workspace) => {
      expect(installInputs(JSON.stringify({ workspaces: [workspace] }), true)).toMatchObject({ ok: false });
    },
  );

  it("phase 1 mounts only the package files and its own two scripts, read-only, with the network on", () => {
    const args = phase1RunArgs({
      context: "colima",
      name: "desk-live-deps-1a2b3c4d",
      runner: "mac:42",
      started: 1_700_000_000_000,
      image: "desk-live:0123456789abcdef",
      repo: "/Users/alex/Dev/tyto-desk",
      installFiles: ["package.json", "package-lock.json", ".npmrc", "packages/core/package.json"],
      depsVolume: "desk-live-deps-0123456789abcdef",
      cache: { kind: "volume", name: CACHE_VOLUME },
    });

    // prettier-ignore
    expect(args).toEqual([
      "--context", "colima", "run", "--rm", "--interactive", "--pull", "never",
      "--name", "desk-live-deps-1a2b3c4d",
      "--label", `${OWNER_LABEL}=1`, "--label", `${RUNNER_LABEL}=mac:42`, "--label", `${STARTED_LABEL}=1700000000000`,
      "--memory", "2g", "--cpus", "2", "--pids-limit", "2048", "--security-opt", "no-new-privileges",
      "--mount", "type=bind,source=/Users/alex/Dev/tyto-desk/package.json,target=/src/package.json,readonly",
      "--mount", "type=bind,source=/Users/alex/Dev/tyto-desk/package-lock.json,target=/src/package-lock.json,readonly",
      "--mount", "type=bind,source=/Users/alex/Dev/tyto-desk/.npmrc,target=/src/.npmrc,readonly",
      "--mount",
      "type=bind,source=/Users/alex/Dev/tyto-desk/packages/core/package.json,target=/src/packages/core/package.json,readonly",
      "--mount", "type=bind,source=/Users/alex/Dev/tyto-desk/scripts/lib/live.mjs,target=/src/scripts/lib/live.mjs,readonly",
      "--mount",
      "type=bind,source=/Users/alex/Dev/tyto-desk/test/live/harness/install.mjs,target=/src/test/live/harness/install.mjs,readonly",
      "--mount", "type=volume,source=desk-live-deps-0123456789abcdef,target=/work/node_modules",
      "--mount", "type=volume,source=desk-live-cache,target=/cache",
      "--env", "DESK_IN_CONTAINER=1",
      "desk-live:0123456789abcdef",
      "flock", "--exclusive", "--wait", "1200", "/cache/desk-live-deps-0123456789abcdef.lock",
      "node", "/src/test/live/harness/install.mjs",
    ]);
  });

  it("phase 1 installs the dependencies with npm ci --ignore-scripts, and starts npm no other way", async () => {
    const install = await readFile(`${repo}test/live/harness/install.mjs`, "utf8");

    expect(npmProcesses(install, "install.mjs")).toEqual([["ci", "--ignore-scripts", "--no-audit", "--no-fund"]]);
  });

  it.each([
    ["an npm install without --ignore-scripts", 'spawn("npm", ["install"]);', [["install"]]],
    ["npm by its path", 'execFile("/usr/local/bin/npm", ["ci"]);', [["ci"]]],
    ["npm in a shell string", 'exec("npm ci --ignore-scripts");', [null]],
    ["an argv that is not literal", 'spawn("npm", args);', [null]],
  ])("the npm-process reader in this test sees %s", (_label, text, found) => {
    expect(npmProcesses(text, "x.mjs")).toEqual(found);
  });

  it("phase 2 mounts only the repo's allowlisted top-level files and directories: never .git, .env files, other directories, or a symbolic link", () => {
    const entries = [
      { name: "package.json", kind: "file" },
      { name: "package-lock.json", kind: "file" },
      { name: ".npmrc", kind: "file" },
      { name: "tsconfig.base.json", kind: "file" },
      { name: "vitest.config.ts", kind: "file" },
      { name: "vitest.live.config.ts", kind: "file" },
      { name: "packages", kind: "dir" },
      { name: "scripts", kind: "dir" },
      { name: "test", kind: "dir" },
      { name: ".git", kind: "dir" },
      { name: ".env", kind: "file" },
      { name: ".env.local", kind: "file" },
      { name: "node_modules", kind: "dir" },
      { name: "test-results", kind: "dir" },
      { name: "docs", kind: "dir" },
      { name: "dist", kind: "dir" },
      { name: "README.md", kind: "file" },
      { name: "tsconfig.json", kind: "other" },
      { name: "packages", kind: "other" },
      { name: "package.json", kind: "dir" },
      { name: "tsconfig,readonly=false.json", kind: "file" },
    ] as const;

    expect(phase2RepoEntries(entries)).toEqual([
      ".npmrc",
      "package-lock.json",
      "package.json",
      "packages",
      "scripts",
      "test",
      "tsconfig.base.json",
      "vitest.config.ts",
      "vitest.live.config.ts",
    ]);
  });

  it("phase 2 runs the suite with no network, the lab's limits and seccomp profile, the repo's allowlisted entries read-only and the dependency volume", () => {
    const args = phase2RunArgs({
      context: "colima",
      name: "desk-live-run-1a2b3c4d",
      runner: "mac:42",
      started: 1_700_000_000_000,
      image: "desk-live:0123456789abcdef",
      repo: "/Users/alex/Dev/tyto-desk",
      repoEntries: ["package.json", "packages", "test"],
      depsVolume: "desk-live-deps-0123456789abcdef",
      run: "1a2b3c4d",
      vitestArgs: ["pty"],
    });

    // prettier-ignore
    expect(args).toEqual([
      "--context", "colima", "run", "--rm", "--interactive", "--pull", "never",
      "--name", "desk-live-run-1a2b3c4d",
      "--label", `${OWNER_LABEL}=1`, "--label", `${RUNNER_LABEL}=mac:42`, "--label", `${STARTED_LABEL}=1700000000000`,
      "--network", "none", "--shm-size", "1g", "--memory", "3g", "--cpus", "3", "--pids-limit", "2048",
      "--security-opt", "seccomp=/Users/alex/Dev/tyto-desk/test/live/chrome-seccomp.json",
      "--security-opt", "no-new-privileges",
      "--mount", "type=bind,source=/Users/alex/Dev/tyto-desk/package.json,target=/src/package.json,readonly",
      "--mount", "type=bind,source=/Users/alex/Dev/tyto-desk/packages,target=/src/packages,readonly",
      "--mount", "type=bind,source=/Users/alex/Dev/tyto-desk/test,target=/src/test,readonly",
      "--mount", "type=volume,source=desk-live-deps-0123456789abcdef,target=/work/node_modules,readonly",
      "--env", "DESK_IN_CONTAINER=1",
      "--env", "DESK_LIVE_RUN=1a2b3c4d",
      "--env", "DESK_LIVE_IMAGE=desk-live:0123456789abcdef",
      "--env", "DESK_LIVE_DEPS=desk-live-deps-0123456789abcdef",
      "desk-live:0123456789abcdef", "node", "/src/test/live/harness/run.mjs", "pty",
    ]);
  });

  it("in GitHub Actions phase 1 drives the runner's own engine through the default context, with the Actions cache directory bound where the Mac mounts the cache volume", () => {
    const args = phase1RunArgs({
      context: CI_CONTEXT,
      name: "desk-live-deps-1a2b3c4d",
      runner: "runnervm:7",
      started: 1_700_000_000_000,
      image: "desk-live:0123456789abcdef",
      repo: "/home/runner/work/tyto-desk/tyto-desk",
      installFiles: ["package.json", "package-lock.json", ".npmrc"],
      depsVolume: "desk-live-deps-0123456789abcdef",
      cache: { kind: "dir", path: "/home/runner/.cache/desk-live" },
    });

    // prettier-ignore
    expect(args).toEqual([
      "--context", "default", "run", "--rm", "--interactive", "--pull", "never",
      "--name", "desk-live-deps-1a2b3c4d",
      "--label", `${OWNER_LABEL}=1`, "--label", `${RUNNER_LABEL}=runnervm:7`, "--label", `${STARTED_LABEL}=1700000000000`,
      "--memory", "2g", "--cpus", "2", "--pids-limit", "2048", "--security-opt", "no-new-privileges",
      "--mount", "type=bind,source=/home/runner/work/tyto-desk/tyto-desk/package.json,target=/src/package.json,readonly",
      "--mount",
      "type=bind,source=/home/runner/work/tyto-desk/tyto-desk/package-lock.json,target=/src/package-lock.json,readonly",
      "--mount", "type=bind,source=/home/runner/work/tyto-desk/tyto-desk/.npmrc,target=/src/.npmrc,readonly",
      "--mount",
      "type=bind,source=/home/runner/work/tyto-desk/tyto-desk/scripts/lib/live.mjs,target=/src/scripts/lib/live.mjs,readonly",
      "--mount",
      "type=bind,source=/home/runner/work/tyto-desk/tyto-desk/test/live/harness/install.mjs,target=/src/test/live/harness/install.mjs,readonly",
      "--mount", "type=volume,source=desk-live-deps-0123456789abcdef,target=/work/node_modules",
      "--mount", "type=bind,source=/home/runner/.cache/desk-live,target=/cache",
      "--env", "DESK_IN_CONTAINER=1",
      "desk-live:0123456789abcdef",
      "flock", "--exclusive", "--wait", "1200", "/cache/desk-live-deps-0123456789abcdef.lock",
      "node", "/src/test/live/harness/install.mjs",
    ]);
  });

  it("in GitHub Actions phase 2 is the Mac's: no network, the lab's limits and seccomp profile, the repo's allowlisted entries and dependencies read-only, through the default context", () => {
    const args = phase2RunArgs({
      context: CI_CONTEXT,
      name: "desk-live-run-1a2b3c4d",
      runner: "runnervm:7",
      started: 1_700_000_000_000,
      image: "desk-live:0123456789abcdef",
      repo: "/home/runner/work/tyto-desk/tyto-desk",
      repoEntries: ["package.json", "test"],
      depsVolume: "desk-live-deps-0123456789abcdef",
      run: "1a2b3c4d",
      vitestArgs: [],
    });

    // prettier-ignore
    expect(args).toEqual([
      "--context", "default", "run", "--rm", "--interactive", "--pull", "never",
      "--name", "desk-live-run-1a2b3c4d",
      "--label", `${OWNER_LABEL}=1`, "--label", `${RUNNER_LABEL}=runnervm:7`, "--label", `${STARTED_LABEL}=1700000000000`,
      "--network", "none", "--shm-size", "1g", "--memory", "3g", "--cpus", "3", "--pids-limit", "2048",
      "--security-opt", "seccomp=/home/runner/work/tyto-desk/tyto-desk/test/live/chrome-seccomp.json",
      "--security-opt", "no-new-privileges",
      "--mount", "type=bind,source=/home/runner/work/tyto-desk/tyto-desk/package.json,target=/src/package.json,readonly",
      "--mount", "type=bind,source=/home/runner/work/tyto-desk/tyto-desk/test,target=/src/test,readonly",
      "--mount", "type=volume,source=desk-live-deps-0123456789abcdef,target=/work/node_modules,readonly",
      "--env", "DESK_IN_CONTAINER=1",
      "--env", "DESK_LIVE_RUN=1a2b3c4d",
      "--env", "DESK_LIVE_IMAGE=desk-live:0123456789abcdef",
      "--env", "DESK_LIVE_DEPS=desk-live-deps-0123456789abcdef",
      "desk-live:0123456789abcdef", "node", "/src/test/live/harness/run.mjs",
    ]);
  });

  it("the live runner takes the suite's done line only with this run's id, so test output cannot fake it", () => {
    expect(doneLine("1a2b3c4d", 0)).toBe("::desk-live-done:: 1a2b3c4d 0");
    expect(doneCode("::desk-live-done:: 1a2b3c4d 3", "1a2b3c4d")).toBe(3);
    expect(doneCode("::desk-live-done:: 1a2b3c4d 0\r", "1a2b3c4d")).toBe(0);
    expect(doneCode("::desk-live-done:: 0", "1a2b3c4d")).toBeNull();
    expect(doneCode("::desk-live-done:: deadbeef 0", "1a2b3c4d")).toBeNull();
    expect(doneCode("  ::desk-live-done:: 1a2b3c4d 0", "1a2b3c4d")).toBeNull();
  });
});

describe("the live runner in GitHub Actions, as live-run.yml runs it", () => {
  type Step = { id?: string; run?: string; uses?: string; if?: string; with?: Record<string, unknown> };
  type Workflow = { jobs: Record<string, { "runs-on"?: string; steps?: Step[] }> };
  const liveRun = async () => {
    const workflow = parse(await readFile(`${repo}.github/workflows/live-run.yml`, "utf8")) as Workflow;
    const job = workflow.jobs.live;
    return { runsOn: job?.["runs-on"], steps: job?.steps ?? [] };
  };
  const action = (steps: Step[], name: string) => steps.filter((step) => step.uses?.split("@")[0] === name);

  it("live-run.yml runs npm run test:live -- --ci on GitHub's ubuntu-24.04-arm runner, once AppArmor's user-namespace limit is lifted", async () => {
    const { runsOn, steps } = await liveRun();
    const suite = steps.findIndex((step) => step.run === "npm run test:live -- --ci");
    const lift = steps.findIndex((step) => step.run === `sudo sysctl -w ${USERNS_LIMIT}=0`);

    expect(runsOn).toBe("ubuntu-24.04-arm");
    expect(suite).toBeGreaterThan(-1);
    expect(lift).toBeGreaterThan(-1);
    expect(lift).toBeLessThan(suite);
  });

  it("live-run.yml restores and saves the Chrome .deb's cache where the --ci runner keeps it", async () => {
    const { steps } = await liveRun();
    const [restore] = action(steps, "actions/cache/restore");
    const [save] = action(steps, "actions/cache/save");

    expect(restore?.with).toEqual({ path: `~/${CI_CACHE_DIR}/${CHROME_CACHE_DIR}`, key: "${{ steps.chrome.outputs.key }}" });
    expect(save?.with).toEqual(restore?.with);
  });

  it("the --ci runner keeps the Chrome .deb under chrome/<sha256>/ of its cache, inside the path live-run.yml caches", async () => {
    const pin = chromePin(await readFile(`${repo}test/live/image/Dockerfile`, "utf8"));

    expect(chromeCacheFile(pin)).toBe(`${CHROME_CACHE_DIR}/${pin.sha256}/${pin.deb}`);
  });

  it("live-run.yml keys the cache by the sha256 of the Chrome .deb that the Dockerfile pins and the runner fetches", async () => {
    const { steps } = await liveRun();
    const keyStep = steps.find((step) => step.id === "chrome");
    const root = await mkdtemp(join(tmpdir(), "live-run-key-"));
    await mkdir(join(root, "test", "live", "image"), { recursive: true });
    await cp(`${repo}test/live/image/Dockerfile`, join(root, "test", "live", "image", "Dockerfile"));
    await writeFile(join(root, "step.sh"), keyStep?.run ?? "exit 3");
    await writeFile(join(root, "output"), "");
    await run("bash", ["--noprofile", "--norc", "-eo", "pipefail", join(root, "step.sh")], {
      cwd: root,
      env: { PATH: "/usr/bin:/bin", GITHUB_OUTPUT: join(root, "output") },
      timeout: 20_000,
    });
    const pin = chromePin(await readFile(`${repo}test/live/image/Dockerfile`, "utf8"));

    expect(await readFile(join(root, "output"), "utf8")).toBe(`key=desk-live-chrome-${pin.sha256}\n`);
  });

  it("live-run.yml uploads test-results/, where the live runner leaves the results, whether or not the suite passed", async () => {
    const { steps } = await liveRun();
    const [upload] = action(steps, "actions/upload-artifact");

    expect(upload?.if).toMatch(/^always\(\)/);
    expect(upload?.with?.path).toBe("test-results/");
    expect(RESULTS_DIR.startsWith(String(upload?.with?.path))).toBe(true);
  });

  it("live-run.yml uploads the results only after a step before it, run whatever the suite did, found them safe to upload", async () => {
    const { steps } = await liveRun();
    const check = steps.findIndex((step) => step.id === "results");
    const upload = steps.findIndex((step) => step.uses?.split("@")[0] === "actions/upload-artifact");

    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(upload);
    expect(steps[check]?.if).toMatch(/^always\(\)/);
    expect(steps[upload]?.if).toMatch(/^always\(\) && .*steps\.results\.outcome == 'success'/);
  });

  /** Runs live-run.yml's own results step, as GitHub runs a step with no shell, in a directory `arrange` filled. */
  const resultsStep = async (arrange: (dir: string) => Promise<unknown>) => {
    const { steps } = await liveRun();
    const dir = await mkdtemp(join(tmpdir(), "live-run-results-"));
    const script = join(await mkdtemp(join(tmpdir(), "live-run-step-")), "step.sh");
    await writeFile(script, steps.find((step) => step.id === "results")?.run ?? "exit 3");
    await arrange(dir);
    return run("bash", ["--noprofile", "--norc", "-e", script], { cwd: dir, env: { PATH: "/usr/bin:/bin" }, timeout: 20_000 }).then(
      ({ stdout }) => ({ code: 0, stdout }),
      (failure: { code?: number; stdout?: string }) => ({ code: failure.code ?? -1, stdout: failure.stdout ?? "" }),
    );
  };
  const results = (dir: string) => mkdir(join(dir, "test-results", "live", "chrome"), { recursive: true });

  it.each([
    ["a symbolic link to a file", async (dir: string) => {
      await results(dir);
      await symlink("/etc/hosts", join(dir, "test-results", "live", "environment.json"));
    }],
    ["a symbolic link to a directory", async (dir: string) => {
      await results(dir);
      await symlink("/etc", join(dir, "test-results", "live", "chrome", "profile"));
    }],
    ["test-results itself as a symbolic link", (dir: string) => symlink("/etc", join(dir, "test-results"))],
  ])("live-run.yml refuses to upload results that hold %s, and prints none of their names", async (_label, arrange) => {
    const { code, stdout } = await resultsStep(arrange);

    expect(code).toBe(1);
    expect(stdout).toMatch(/^::error title=live::/m);
    expect(stdout).not.toMatch(/environment\.json|profile|\/etc/);
  });

  it.each([
    ["results of plain files and directories", async (dir: string) => {
      await results(dir);
      await writeFile(join(dir, "test-results", "live", "vitest.json"), "{}");
      await writeFile(join(dir, "test-results", "live", "chrome", "chrome.log"), "log");
    }],
    ["a run that left no test-results/", async () => undefined],
  ])("live-run.yml's check before the upload lets through %s", async (_label, arrange) => {
    expect((await resultsStep(arrange)).code).toBe(0);
  });

  it.each([
    ["1\n", true],
    ["2\n", true],
    ["", true],
    ["0\n", false],
    ["0", false],
    [null, false],
  ])(
    "with --ci the live runner refuses while Ubuntu's AppArmor limits unprivileged user namespaces, which Chrome's sandbox needs (%j)",
    (value, refused) => {
      const reason = userNamespaceRefusal(value);

      expect(reason !== null).toBe(refused);
      if (reason !== null) expect(reason).toContain(`sudo sysctl -w ${USERNS_LIMIT}=0`);
    },
  );

  it("the live runner needs nothing npm installs, since live-run.yml runs it before any npm ci", async () => {
    const root = await mkdtemp(join(tmpdir(), "live-runner-bare-"));
    await cp(`${repo}scripts`, join(root, "scripts"), { recursive: true });
    const result = await run(process.execPath, [join(root, "scripts", "live.mjs"), "--ci"], {
      env: { PATH: dirname(process.execPath), HOME: root },
      timeout: 20_000,
    }).then(
      () => ({ code: 0, stderr: "" }),
      (failure: { code?: number; stderr?: string }) => ({ code: failure.code ?? -1, stderr: failure.stderr ?? "" }),
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^test:live: --ci runs only in GitHub Actions/);
  });
});

describe("the live results on the Mac", () => {
  it("the live runner finds every entry in the results that is not a plain file or directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-results-"));
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "vitest.json"), "{}");
    await writeFile(join(dir, "nested", "chrome.log"), "log");
    await symlink("/etc/hosts", join(dir, "environment.json"));
    await symlink("..", join(dir, "nested", "up"));

    expect(await unsafeResultEntries(dir)).toEqual(["environment.json", "nested/up"]);
  });

  it("the live runner finds nothing wrong with results of plain files and directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-results-"));
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "vitest.json"), "{}");
    await writeFile(join(dir, "nested", "chrome.log"), "log");

    expect(await unsafeResultEntries(dir)).toEqual([]);
  });

  it("the live runner reads a result file only when it is a regular file, never through a link", async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-results-"));
    const outside = join(await mkdtemp(join(tmpdir(), "outside-")), "secret.json");
    await writeFile(outside, '{"value":"fake"}');
    await writeFile(join(dir, "vitest.json"), '{"numTotalTests":1}');
    await symlink(outside, join(dir, "environment.json"));

    expect(await readResultFile(join(dir, "vitest.json"))).toBe('{"numTotalTests":1}');
    expect(await readResultFile(join(dir, "environment.json"))).toBeNull();
    expect(await readResultFile(join(dir, "missing.json"))).toBeNull();
  });
});

describe("pruning the harness's images and volumes", () => {
  const hour = 3_600_000;
  const at = (hoursAgo: number) => Date.parse("2026-10-06T22:00:00Z") - hoursAgo * hour;
  const resource = { [RESOURCE_LABEL]: "1" };
  const legacy = { [OWNER_LABEL]: "1" };

  it("the live runner prunes harness images other than the current one and the newest other one", () => {
    const images = [
      { repository: "desk-live", tag: "aaaaaaaaaaaaaaaa", createdAt: at(1), labels: resource },
      { repository: "desk-live-fetch", tag: "aaaaaaaaaaaaaaaa", createdAt: at(1), labels: resource },
      { repository: "desk-live", tag: "bbbbbbbbbbbbbbbb", createdAt: at(2), labels: legacy },
      { repository: "desk-live-fetch", tag: "bbbbbbbbbbbbbbbb", createdAt: at(2), labels: legacy },
      { repository: "desk-live", tag: "cccccccccccccccc", createdAt: at(3), labels: resource },
      { repository: "desk-live-fetch", tag: "cccccccccccccccc", createdAt: at(3), labels: resource },
      { repository: "desk-live", tag: "dddddddddddddddd", createdAt: at(30), labels: legacy },
      // Not the harness's: another repository, a hand-made tag, or no harness label.
      { repository: "desk-lab", tag: "latest", createdAt: at(40), labels: {} },
      { repository: "desk-live", tag: "mine", createdAt: at(40), labels: resource },
      { repository: "desk-live", tag: "eeeeeeeeeeeeeeee", createdAt: at(40), labels: {} },
    ];

    expect(imagesToPrune(images, "desk-live:aaaaaaaaaaaaaaaa").sort()).toEqual([
      "desk-live-fetch:cccccccccccccccc",
      "desk-live:cccccccccccccccc",
      "desk-live:dddddddddddddddd",
    ]);
  });

  it("the live runner prunes dependency volumes other than the current one and the newest other one, never the cache", () => {
    const volumes = [
      { name: "desk-live-deps-aaaaaaaaaaaaaaaa", createdAt: at(1), labels: resource },
      { name: "desk-live-deps-bbbbbbbbbbbbbbbb", createdAt: at(5), labels: legacy },
      { name: "desk-live-deps-cccccccccccccccc", createdAt: at(2), labels: resource },
      { name: "desk-live-deps-dddddddddddddddd", createdAt: at(9), labels: resource },
      { name: CACHE_VOLUME, createdAt: at(50), labels: legacy },
      { name: "desk-live-deps-eeeeeeeeeeeeeeee", createdAt: at(50), labels: {} },
      { name: "er-postgres-data", createdAt: at(50), labels: resource },
    ];

    expect(volumesToPrune(volumes, "desk-live-deps-aaaaaaaaaaaaaaaa").sort()).toEqual([
      "desk-live-deps-bbbbbbbbbbbbbbbb",
      "desk-live-deps-dddddddddddddddd",
    ]);
  });

  it.each([
    ["2026-10-06 17:27:01 -0500 CDT", Date.parse("2026-10-06T22:27:01Z")],
    ["2026-10-06T22:27:01.123456789Z", Date.parse("2026-10-06T22:27:01.123Z")],
    ["not a time", null],
  ])("the live runner reads docker's time %j", (text, ms) => {
    expect(dockerTime(text)).toBe(ms);
  });
});

describe("the live image and the files it sees", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const files = [
    { path: "Dockerfile", bytes: bytes("FROM scratch\n") },
    { path: "build-context", bytes: bytes("#!/bin/bash\n") },
    { path: "tools/package-lock.json", bytes: bytes("{}\n") },
    { path: "tools/package.json", bytes: bytes("{}\n") },
  ];

  it("the live image is tagged by the content of test/live/image, whatever order the files are read in", () => {
    expect(imageTag(files)).toMatch(/^desk-live:[0-9a-f]{16}$/);
    expect(imageTag([...files].reverse())).toBe(imageTag(files));
  });

  it.each([
    ["a changed byte", files.map((f, i) => (i === 0 ? { ...f, bytes: bytes("FROM scratch \n") } : f))],
    ["a renamed file", files.map((f, i) => (i === 1 ? { ...f, path: "build-context.sh" } : f))],
    ["a new file", [...files, { path: "extra", bytes: bytes("") }]],
  ])("the live image gets a new tag for %s", (_label, changed) => {
    expect(imageTag(changed)).not.toBe(imageTag(files));
  });

  it("the live image tag sorts paths by code unit, not by the machine's locale", () => {
    const upper = [{ path: "B", bytes: bytes("1") }, { path: "a", bytes: bytes("2") }];

    expect(imageTag(upper)).toBe(imageTag([...upper].reverse()));
    expect(imageTag(upper)).toBe(expectedTag([{ path: "B", text: "1" }, { path: "a", text: "2" }]));
  });

  it("the live image pins branded Chrome for linux-arm64 by version and sha256", async () => {
    const pin = chromePin(await readFile(`${repo}test/live/image/Dockerfile`, "utf8"));

    expect(pin.deb).toMatch(/^google-chrome-stable_\d+\.\d+\.\d+\.\d+-\d+_arm64\.deb$/);
    expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.url).toBe(`https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/${pin.deb}`);
  });

  it("the live image installs its npm tools with npm ci --ignore-scripts, and runs npm for nothing else but its version", async () => {
    const dockerfile = await readFile(`${repo}test/live/image/Dockerfile`, "utf8");
    const npm = shellCommands(dockerfile).filter((words) => words.some((word) => word === "npm" || word.endsWith("/npm")));

    expect(npm).toEqual([
      ["npm", "--version"],
      ["npm", "ci", "--ignore-scripts"],
    ]);
  });

  it("the live image names its Debian base literally, pinned by digest, so Dependabot can read and bump it", async () => {
    const dockerfile = await readFile(`${repo}test/live/image/Dockerfile`, "utf8");

    expect(dockerfile).toMatch(/^FROM debian:trixie-slim@sha256:[0-9a-f]{64} AS fetch$/m);
    expect(dockerfile).not.toMatch(/^FROM \$/m);
  });

  it("Dependabot's docker updater watches /test/live/image, where the live image's Dockerfile is", async () => {
    type Update = { "package-ecosystem"?: string; directory?: string };
    const config = parse(await readFile(`${repo}.github/dependabot.yml`, "utf8")) as { updates?: Update[] };
    const docker = (config.updates ?? []).filter((update) => update["package-ecosystem"] === "docker");

    expect(docker.map((update) => update.directory)).toEqual(["/test/live/image"]);
    expect(await readFile(`${repo}test/live/image/Dockerfile`, "utf8")).toMatch(/^FROM debian:/m);
  });

  it.each([
    ["no Chrome pin at all", "FROM debian\n"],
    ["a version without a sha256", "ARG CHROME_DEB=google-chrome-stable_155.0.8059.39-1_arm64.deb\n"],
    ["an amd64 .deb", `ARG CHROME_DEB=google-chrome-stable_155.0.8059.39-1_amd64.deb\nARG CHROME_SHA256=${"a".repeat(64)}\n`],
  ])("the live runner refuses an image with %s", (_label, dockerfile) => {
    expect(() => chromePin(dockerfile)).toThrow(/must pin CHROME_DEB and CHROME_SHA256/);
  });

  it.each([
    "package.json",
    "package-lock.json",
    ".npmrc",
    "tsconfig.base.json",
    "vitest.live.config.ts",
    "packages/core/src/index.ts",
    "test/live/chrome.test.ts",
    "scripts/lib/live.mjs",
  ])("the live container copies %s from the read-only repo", (path) => {
    expect(repoPathAllowed(path)).toBe(true);
  });

  it.each([
    ".env",
    ".git/config",
    "node_modules/vitest/package.json",
    "packages/core/node_modules/x/index.js",
    "test-results/live/vitest.json",
    "dist/core/index.js",
    "docs/IMPLEMENTATION.md",
    "test/live/.desk/config.json",
    "test/.agent-browser/sessions/main.json",
    "../outside.json",
  ])("the live container leaves %s out", (path) => {
    expect(repoPathAllowed(path)).toBe(false);
  });

  it("the repo's .dockerignore is the live container's allowlist", async () => {
    expect(await readFile(`${repo}.dockerignore`, "utf8")).toBe(dockerignoreText());
  });
});

/**
 * The tag scheme spelled out: the sha256 over each file's path, NUL, byte length, NUL and bytes, taken in the order
 * given (the caller lists them in code-unit order of path), as 16 hex digits.
 */
function expectedTag(entries: { path: string; text: string }[]): string {
  const hash = createHash("sha256");
  for (const { path, text } of entries) {
    const data = new TextEncoder().encode(text);
    hash.update(path).update("\0").update(String(data.length)).update("\0").update(data);
  }
  return `desk-live:${hash.digest("hex").slice(0, 16)}`;
}
