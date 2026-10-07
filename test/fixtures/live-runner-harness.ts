/**
 * The live runner script's test harness (scripts/lib/live-runner.mjs), shared by the two files that test it so they run in
 * parallel (npm test stays under SPEC §8's 30 s): a checkout under a stand-in home, a stub docker that plays a
 * scenario, and the runner's inputs.
 */
import { execFile } from "node:child_process";
import type { EventEmitter } from "node:events";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { OWNER_LABEL, RUNNER_LABEL, STARTED_LABEL, USERNS_LIMIT } from "../../scripts/lib/live.mjs";
import { runLive } from "../../scripts/lib/live-runner.mjs";
import { linkSharedExecutable, shQuote } from "./fake-exec.ts";

export const run = promisify(execFile);
export const repo = fileURLToPath(new URL("../..", import.meta.url));
const stubScript = fileURLToPath(new URL("./stub-docker.mjs", import.meta.url));

/** A container as `docker ps --format '{{json .}}'` lists it. */
export type Listed = { ID: string; Names: string; State: string; Labels: string };

export type Scenario = {
  context: string | null;
  info: Record<string, unknown> | null;
  imageCached?: boolean;
  volumesExist?: boolean;
  depsReady?: boolean;
  depsCheckExit?: number;
  containers?: Listed[];
  phase2?: { stdout?: string[]; stderr?: string; untilKilled?: boolean; ignoreKill?: boolean; done?: number | null; exit: number };
  results?: string;
  resultsSymlink?: { name: string; target: string };
  cpExit?: number;
};

export type RunOptions = {
  argv?: string[];
  platform?: string;
  env?: Record<string, string>;
  signals?: EventEmitter;
  onOut?: (text: string) => void;
  docker?: string;
  /** The host's kernel.apparmor_restrict_unprivileged_userns ("0\n" unless given); null: the kernel has none. */
  userns?: string | null;
};

export const NOW = Date.parse("2026-10-06T22:00:00Z");
export const colimaVm = { Name: "colima", OSType: "linux", Architecture: "aarch64", MemTotal: 6_197_440_512 };
export const actionsEngine = { Name: "runnervm", OSType: "linux", Architecture: "aarch64", MemTotal: 16 * 1024 ** 3 };

/**
 * A checkout under a stand-in home (the image directory and fake package files are all the runner reads), a stand-in
 * /proc/sys, a stub `docker` that plays the scenario, and the suite's results as the container would leave them.
 */
export async function harness(scenario: (home: string) => Scenario) {
  const base = await mkdtemp(join(tmpdir(), "live-runner-"));
  const home = join(base, "home");
  const checkout = join(home, "tyto-desk");
  await cp(join(repo, "test", "live", "image"), join(checkout, "test", "live", "image"), { recursive: true });
  await mkdir(join(checkout, "packages", "core"), { recursive: true });
  await writeFile(join(checkout, "package.json"), JSON.stringify({ name: "tyto-desk", workspaces: ["packages/core"] }));
  await writeFile(join(checkout, "package-lock.json"), JSON.stringify({ name: "tyto-desk", lockfileVersion: 3 }));
  await writeFile(join(checkout, ".npmrc"), "ignore-scripts=true\n");
  await writeFile(join(checkout, "packages", "core", "package.json"), JSON.stringify({ name: "@desk/core" }));
  const procSys = join(base, "proc-sys");
  const usernsLimit = join(procSys, ...USERNS_LIMIT.split("."));
  await mkdir(dirname(usernsLimit), { recursive: true });

  const results = join(base, "container-results");
  await mkdir(results);
  await writeFile(
    join(results, "vitest.json"),
    JSON.stringify({ numPassedTests: 3, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numTotalTests: 3 }),
  );
  await writeFile(join(results, "environment.json"), JSON.stringify({ chrome: "Google Chrome 155.0.8059.39", exitCode: 0 }));

  const log = join(base, "calls.log");
  await writeFile(log, "");
  const scenarioFile = join(base, "scenario.json");
  await writeFile(scenarioFile, JSON.stringify({ results, ...scenario(home) }));
  // <base>/bin/docker finds the scenario and the log in <base>, so every harness's docker is one shared file.
  const docker = join(base, "bin", "docker");
  await mkdir(dirname(docker));
  const stub = `#!/bin/sh\nhere=\${0%/*}/..\nexec ${shQuote(process.execPath)} ${shQuote(stubScript)} "$here/scenario.json" "$here/calls.log" "$@"\n`;
  await linkSharedExecutable("stub-docker", stub, docker);

  return {
    home,
    checkout,
    resultsDir: join(checkout, "test-results", "live"),
    calls: async (): Promise<string[][]> =>
      (await readFile(log, "utf8"))
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as string[]),
    run: async (options: RunOptions = {}) => {
      if (options.userns === null) await rm(usernsLimit, { force: true });
      else await writeFile(usernsLimit, options.userns ?? "0\n");
      let out = "";
      let err = "";
      const code = await runLive({
        argv: options.argv ?? [],
        env: { HOME: home, PATH: "/usr/bin:/bin", ...options.env },
        platform: options.platform ?? "darwin",
        arch: "arm64",
        repo: checkout,
        home,
        host: "test-mac",
        pid: process.pid,
        docker: options.docker ?? docker,
        procSys,
        out: (text) => {
          out += text;
          options.onOut?.(text);
        },
        err: (text) => {
          err += text;
        },
        signals: options.signals ?? null,
        now: () => NOW,
      });
      return { code, out, err };
    },
  };
}

export type Harness = Awaited<ReturnType<typeof harness>>;

export const onTheMac = (home: string): Scenario => ({
  context: `unix://${home}/.colima/default/docker.sock`,
  info: colimaVm,
  imageCached: true,
  volumesExist: true,
  depsReady: true,
});

/** GitHub's ubuntu-24.04-arm runner: no colima context, the runner's own engine. */
export const inActions = (): Scenario => ({
  context: null,
  info: actionsEngine,
  imageCached: true,
  volumesExist: true,
  depsReady: true,
});

/** What live-run.yml runs: `npm run test:live -- --ci` with GITHUB_ACTIONS=true on linux-arm64. */
export const ci: RunOptions = { argv: ["--ci"], platform: "linux", env: { GITHUB_ACTIONS: "true" } };

/** The same guards hold on the Mac and in GitHub Actions. */
export const modes = [
  { mode: "on the Mac", scenario: onTheMac, options: {} as RunOptions },
  { mode: "in GitHub Actions", scenario: inActions, options: ci },
];

/** A Desk container another host's runner started `agoMs` ago. */
export const anotherRunners = (id: string, state: string, agoMs: number): Listed => ({
  ID: id,
  Names: `desk-live-run-${id}`,
  State: state,
  Labels: [`${OWNER_LABEL}=1`, `${RUNNER_LABEL}=another-host:7`, `${STARTED_LABEL}=${NOW - agoMs}`].join(","),
});

export const exists = (path: string) => access(path).then(() => true, () => false);
export const withoutContext = (call: string[]) => (call[0] === "--context" ? call.slice(2) : call);
export const subcommand = (call: string[]) => withoutContext(call)[0];

/** Phase 2's docker argv in a run, with the checkout and the run's random id written as placeholders. */
export async function phase2Call(live: Harness): Promise<string[]> {
  const call = (await live.calls()).find((c) => c.some((arg) => arg.endsWith("/run.mjs"))) ?? [];
  const runId = call.find((arg) => arg.startsWith("DESK_LIVE_RUN="))?.slice("DESK_LIVE_RUN=".length) ?? "none";
  return call.map((arg) => arg.replaceAll(live.checkout, "<repo>").replaceAll(runId, "<run>"));
}
