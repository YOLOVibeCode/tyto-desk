import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  CHROME_CACHE_DIR,
  CI_CACHE_DIR,
  OWNER_LABEL,
  RUNNER_LABEL,
  STARTED_LABEL,
  USERNS_LIMIT,
  chromeCacheFile,
  chromePin,
} from "../scripts/lib/live.mjs";
import { runLive } from "../scripts/lib/live-runner.mjs";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("..", import.meta.url));
const stubScript = fileURLToPath(new URL("./fixtures/stub-docker.mjs", import.meta.url));

/** A container as `docker ps --format '{{json .}}'` lists it. */
type Listed = { ID: string; Names: string; State: string; Labels: string };

type Scenario = {
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

type RunOptions = {
  argv?: string[];
  platform?: string;
  env?: Record<string, string>;
  signals?: EventEmitter;
  onOut?: (text: string) => void;
  docker?: string;
  /** The host's kernel.apparmor_restrict_unprivileged_userns ("0\n" unless given); null: the kernel has none. */
  userns?: string | null;
};

const NOW = Date.parse("2026-10-06T22:00:00Z");
const colimaVm = { Name: "colima", OSType: "linux", Architecture: "aarch64", MemTotal: 6_197_440_512 };
const actionsEngine = { Name: "runnervm", OSType: "linux", Architecture: "aarch64", MemTotal: 16 * 1024 ** 3 };

/**
 * A checkout under a stand-in home (the image directory and fake package files are all the runner reads), a stand-in
 * /proc/sys, a stub `docker` that plays the scenario, and the suite's results as the container would leave them.
 */
async function harness(scenario: (home: string) => Scenario) {
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
  const docker = join(base, "bin", "docker");
  await mkdir(dirname(docker));
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  await writeFile(
    docker,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(stubScript)} ${quote(scenarioFile)} ${quote(log)} "$@"\n`,
  );
  await chmod(docker, 0o755);

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

type Harness = Awaited<ReturnType<typeof harness>>;

const onTheMac = (home: string): Scenario => ({
  context: `unix://${home}/.colima/default/docker.sock`,
  info: colimaVm,
  imageCached: true,
  volumesExist: true,
  depsReady: true,
});

/** GitHub's ubuntu-24.04-arm runner: no colima context, the runner's own engine. */
const inActions = (): Scenario => ({
  context: null,
  info: actionsEngine,
  imageCached: true,
  volumesExist: true,
  depsReady: true,
});

/** What live-run.yml runs: `npm run test:live -- --ci` with GITHUB_ACTIONS=true on linux-arm64. */
const ci: RunOptions = { argv: ["--ci"], platform: "linux", env: { GITHUB_ACTIONS: "true" } };

/** The same guards hold on the Mac and in GitHub Actions. */
const modes = [
  { mode: "on the Mac", scenario: onTheMac, options: {} as RunOptions },
  { mode: "in GitHub Actions", scenario: inActions, options: ci },
];

/** A Desk container another host's runner started `agoMs` ago. */
const anotherRunners = (id: string, state: string, agoMs: number): Listed => ({
  ID: id,
  Names: `desk-live-run-${id}`,
  State: state,
  Labels: [`${OWNER_LABEL}=1`, `${RUNNER_LABEL}=another-host:7`, `${STARTED_LABEL}=${NOW - agoMs}`].join(","),
});

const exists = (path: string) => access(path).then(() => true, () => false);
const withoutContext = (call: string[]) => (call[0] === "--context" ? call.slice(2) : call);
const subcommand = (call: string[]) => withoutContext(call)[0];

/** Phase 2's docker argv in a run, with the checkout and the run's random id written as placeholders. */
async function phase2Call(live: Harness): Promise<string[]> {
  const call = (await live.calls()).find((c) => c.some((arg) => arg.endsWith("/run.mjs"))) ?? [];
  const runId = call.find((arg) => arg.startsWith("DESK_LIVE_RUN="))?.slice("DESK_LIVE_RUN=".length) ?? "none";
  return call.map((arg) => arg.replaceAll(live.checkout, "<repo>").replaceAll(runId, "<run>"));
}

describe("the live runner script, driving a stub docker", () => {
  it("the live runner refuses before it runs anything but docker context inspect and info", async () => {
    const live = await harness(() => ({ context: "unix:///var/run/docker-desktop.sock", info: colimaVm }));

    const { code, err } = await live.run();

    expect(code).toBe(1);
    expect(err).toMatch(/not at a Colima socket/);
    expect(await live.calls()).toEqual([
      ["context", "inspect", "colima"],
      ["--context", "colima", "info", "--format", "{{json .}}"],
    ]);
  });

  it("the live runner refuses --ci outside GitHub Actions before it runs docker at all", async () => {
    const live = await harness(onTheMac);

    const { code, err } = await live.run({ argv: ["--ci"], platform: "linux" });

    expect(code).toBe(1);
    expect(err).toMatch(/GitHub Actions/);
    expect(await live.calls()).toEqual([]);
  });

  it.each(modes)("the live runner copies the results out when the suite is done and exits with its status ($mode)", async ({ scenario, options }) => {
    const live = await harness((home) => ({ ...scenario(home), phase2: { stdout: ["vitest ran"], done: 0, exit: 0 } }));

    const { code, out } = await live.run(options);

    expect(code).toBe(0);
    expect(out).toMatch(/3 passed, 0 failed, 0 skipped, of 3/);
    expect(JSON.parse(await readFile(join(live.resultsDir, "vitest.json"), "utf8"))).toMatchObject({ numPassedTests: 3 });
  });

  it.each(modes)("a live run that ends before the suite finishes reports no results, never the previous run's ($mode)", async ({ scenario, options }) => {
    const live = await harness((home) => ({
      ...scenario(home),
      phase2: { stderr: "phase 2: Xvfb did not start on :99 (see xvfb.log)", done: null, exit: 1 },
    }));
    await mkdir(live.resultsDir, { recursive: true });
    await writeFile(
      join(live.resultsDir, "vitest.json"),
      JSON.stringify({ numPassedTests: 8, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numTotalTests: 8 }),
    );

    const { code, out } = await live.run(options);

    expect(code).toBe(1);
    expect(out).toMatch(/no results: the container ended before the suite finished \(exit 1\)/);
    expect(out).not.toMatch(/passed/);
    expect(await exists(join(live.resultsDir, "vitest.json"))).toBe(false);
    expect((await live.calls()).map(subcommand)).not.toContain("cp");
  });

  it.each(modes)(
    "the live run's status is the container's exit status, and only this run's done line copies the results ($mode)",
    async ({ scenario, options }) => {
      const live = await harness((home) => ({
        ...scenario(home),
        phase2: { stdout: ["::desk-live-done:: 0", "::desk-live-done:: deadbeef 0", "a test printed that"], done: 0, exit: 1 },
      }));

      const { code } = await live.run(options);

      expect(code).toBe(1);
      expect((await live.calls()).map(subcommand).filter((c) => c === "cp")).toHaveLength(1);
    },
  );

  it.each(modes)("a live run whose results cannot be copied out fails, whatever the suite's status ($mode)", async ({ scenario, options }) => {
    const live = await harness((home) => ({ ...scenario(home), phase2: { done: 0, exit: 0 }, cpExit: 1 }));

    const { code, err } = await live.run(options);

    expect(code).toBe(1);
    expect(err).toMatch(/docker cp failed/);
  });

  it.each(modes)(
    "the live runner deletes results that hold a symbolic link, reads none of them, and fails the run ($mode)",
    async ({ scenario, options }) => {
      const live = await harness((home) => ({
        ...scenario(home),
        phase2: { done: 0, exit: 0 },
        resultsSymlink: { name: "chrome-agent-browser.log", target: "/etc/hosts" },
      }));

      const { code, out, err } = await live.run(options);

      expect(code).toBe(1);
      expect(err).toMatch(/1 entry that is not a plain file or directory/);
      expect(out).not.toMatch(/passed/);
      expect(await exists(live.resultsDir)).toBe(false);
    },
  );

  it.each(modes)(
    "a dependency check that docker itself fails stops the run and neither reinstalls nor removes the volume ($mode)",
    async ({ scenario, options }) => {
      const live = await harness((home) => ({ ...scenario(home), depsCheckExit: 125 }));

      const { code, err } = await live.run(options);
      const calls = await live.calls();

      expect(code).toBe(1);
      expect(err).toMatch(/checking desk-live-deps-[0-9a-f]{16} failed \(exit 125\)/);
      expect(calls.some((call) => call.some((arg) => arg.endsWith("/install.mjs")))).toBe(false);
      expect(calls.some((call) => call.includes("volume") && call.includes("rm"))).toBe(false);
    },
  );

  it.each(modes)(
    "the live runner removes a stopped desk-live container another runner left before it starts its own ($mode)",
    async ({ scenario, options }) => {
      const live = await harness((home) => ({
        ...scenario(home),
        containers: [anotherRunners("left0ver", "exited", 3 * 60 * 60_000)],
        phase2: { done: 0, exit: 0 },
      }));

      const { code } = await live.run(options);
      const calls = (await live.calls()).map(withoutContext);
      const removal = calls.findIndex((call) => call[0] === "rm" && call.includes("left0ver"));

      expect(code).toBe(0);
      expect(removal).toBeGreaterThan(-1);
      expect(removal).toBeLessThan(calls.findIndex((call) => call[0] === "run"));
    },
  );

  it.each(modes)(
    "the live runner starts no container while as many Desk live containers run as the engine's memory allows ($mode)",
    async ({ scenario, options }) => {
      const live = await harness((home) => ({
        ...scenario(home),
        containers: [anotherRunners("running1", "running", 60_000), anotherRunners("running2", "running", 60_000)],
      }));

      const { code, err } = await live.run(options);

      expect(code).toBe(1);
      expect(err).toMatch(/Desk live containers? (is|are already) running/);
      expect((await live.calls()).map(subcommand)).not.toContain("run");
    },
  );

  it.each(modes)("a missing docker CLI is one test:live line, not a stack trace ($mode)", async ({ scenario, options }) => {
    const live = await harness(scenario);

    const { code, err } = await live.run({ ...options, docker: join(live.home, "no-such-docker") });

    expect(code).toBe(1);
    expect(err).toMatch(/^test:live: docker is not installed or not on PATH/);
    expect(err).not.toMatch(/\n\s+at /);
  });

  it("npm run test:live -- --ci refuses outside GitHub Actions before it runs docker", async () => {
    const result = await run(process.execPath, [join(repo, "scripts", "live.mjs"), "--ci"], {
      env: { PATH: dirname(process.execPath), HOME: tmpdir() },
      timeout: 20_000,
    }).then(
      () => ({ code: 0, stderr: "" }),
      (failure: { code?: number; stderr?: string }) => ({ code: failure.code ?? -1, stderr: failure.stderr ?? "" }),
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^test:live: --ci runs only in GitHub Actions/);
  });

  it.each(modes)(
    "the first interrupt stops the suite through its container, and the results still come out ($mode)",
    async ({ scenario, options }) => {
      const live = await harness((home) => ({ ...scenario(home), phase2: { untilKilled: true, done: 143, exit: 143 } }));
      const signals = new EventEmitter();

      const { code, out, err } = await live.run({
        ...options,
        signals,
        onOut: (text) => {
          if (text.includes("suite running")) signals.emit("SIGINT");
        },
      });
      const calls = await live.calls();

      expect(code).toBe(130);
      expect(err).toMatch(/SIGINT: stopping the suite/);
      expect(calls.some((call) => subcommand(call) === "kill" && call.includes("SIGTERM"))).toBe(true);
      expect(calls.map(subcommand)).toContain("cp");
      expect(out).toMatch(/3 passed/);
    },
  );

  it.each(modes)("a second interrupt removes the run's containers and copies nothing ($mode)", async ({ scenario, options }) => {
    const live = await harness((home) => ({
      ...scenario(home),
      phase2: { untilKilled: true, ignoreKill: true, done: 0, exit: 0 },
    }));
    const signals = new EventEmitter();

    const { code, out, err } = await live.run({
      ...options,
      signals,
      onOut: (text) => {
        if (!text.includes("suite running")) return;
        signals.emit("SIGINT");
        signals.emit("SIGINT");
      },
    });

    expect(code).toBe(130);
    expect(err).toMatch(/SIGINT, removing this run's containers/);
    expect((await live.calls()).map(subcommand)).not.toContain("cp");
    expect(out).not.toMatch(/passed|no results/);
  });

  it("without --ci the live runner drives docker only through the colima context", async () => {
    const live = await harness((home) => ({
      ...onTheMac(home),
      imageCached: false,
      volumesExist: false,
      depsReady: false,
      phase2: { done: 0, exit: 0 },
    }));

    const { code } = await live.run();
    const calls = await live.calls();

    expect(code).toBe(0);
    expect(calls[0]).toEqual(["context", "inspect", "colima"]);
    expect(calls.slice(1).every((call) => call[0] === "--context" && call[1] === "colima")).toBe(true);
    expect(calls.flat().join(" ")).not.toContain(CI_CACHE_DIR);
  });

  it("in GitHub Actions the live runner drives the runner's own engine through the default context and keeps the Chrome .deb where live-run.yml caches it", async () => {
    const live = await harness(() => ({
      ...inActions(),
      imageCached: false,
      volumesExist: false,
      depsReady: false,
      phase2: { done: 0, exit: 0 },
    }));
    const pin = chromePin(await readFile(join(live.checkout, "test", "live", "image", "Dockerfile"), "utf8"));

    const { code } = await live.run(ci);
    const calls = await live.calls();
    const cache = `type=bind,source=${live.home}/${CI_CACHE_DIR},target=/cache`;
    const runs = (marker: string) => calls.filter((call) => subcommand(call) === "run" && call.some((arg) => arg.includes(marker)));
    const fetch = runs("fetch-verified")[0] ?? [];

    expect(code).toBe(0);
    expect(calls.every((call) => call[0] === "--context" && call[1] === "default")).toBe(true);
    expect(calls.flat().join(" ")).not.toMatch(/colima|desk-live-cache/);
    expect(runs("chown")[0]).toContain(`type=bind,source=${live.home}/${CI_CACHE_DIR},target=/volume`);
    expect(fetch).toContain(cache);
    // /cache/chrome/<sha256>/<deb> in the container is ~/.cache/desk-live/chrome/<sha256>/<deb> on the runner, inside
    // ~/.cache/desk-live/chrome, the path live-run.yml restores and saves.
    expect(fetch.slice(-3)).toEqual([pin.url, pin.sha256, `/cache/${chromeCacheFile(pin)}`]);
    expect(chromeCacheFile(pin).startsWith(`${CHROME_CACHE_DIR}/`)).toBe(true);
    expect(runs("build-context")[0]).toContain(`${cache},readonly`);
    expect(runs("install.mjs")[0]).toContain(cache);
    expect(runs("run.mjs")[0]?.slice(-1)).toEqual(["/src/test/live/harness/run.mjs"]);
    expect(await exists(join(live.home, CI_CACHE_DIR))).toBe(true);
    expect(await exists(join(live.checkout, "test-results", "live", "vitest.json"))).toBe(true);
  });

  it("in GitHub Actions phase 2 is the Mac's phase 2, with no network, but for the docker context", async () => {
    const mac = await harness((home) => ({ ...onTheMac(home), phase2: { done: 0, exit: 0 } }));
    const actions = await harness(() => ({ ...inActions(), phase2: { done: 0, exit: 0 } }));

    expect((await mac.run()).code).toBe(0);
    expect((await actions.run(ci)).code).toBe(0);
    const onMac = await phase2Call(mac);
    const inCi = await phase2Call(actions);

    expect(onMac.slice(0, 2)).toEqual(["--context", "colima"]);
    expect(inCi.slice(0, 2)).toEqual(["--context", "default"]);
    expect(inCi.slice(2)).toEqual(onMac.slice(2));
    expect(inCi.join(" ")).toContain("--network none");
  });

  it("with --ci the live runner refuses before any docker command while Ubuntu's AppArmor limits unprivileged user namespaces", async () => {
    const live = await harness(inActions);

    const { code, err } = await live.run({ ...ci, userns: "1\n" });

    expect(code).toBe(1);
    expect(err).toMatch(/^test:live: /);
    expect(err).toContain(`sudo sysctl -w ${USERNS_LIMIT}=0`);
    expect(await live.calls()).toEqual([]);
  });

  it("with --ci the live runner runs on a kernel without AppArmor's user-namespace limit", async () => {
    const live = await harness(() => ({ ...inActions(), phase2: { done: 0, exit: 0 } }));

    const { code } = await live.run({ ...ci, userns: null });

    expect(code).toBe(0);
  });

  it("on the Mac the live runner leaves the user-namespace limit to the Colima VM", async () => {
    const live = await harness((home) => ({ ...onTheMac(home), phase2: { done: 0, exit: 0 } }));

    const { code } = await live.run({ userns: "1\n" });

    expect(code).toBe(0);
  });
});
