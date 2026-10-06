#!/usr/bin/env node
/**
 * test:live — the only part of the live suite that runs on the Mac (docs/IMPLEMENTATION.md §17.3). It drives
 * `docker --context colima` and nothing else: it never starts, stops or restarts the VM, never touches a container it
 * did not start, and opens nothing on the screen. Chrome, the PTYs and agent-browser run in a Linux container under
 * Xvfb.
 *
 *   image    desk-live:<hash of test/live/image>, built only when a file there changes; the pinned Chrome .deb comes
 *            from the desk-live-cache volume (fetched once, by sha256) and is streamed into the build context.
 *   phase 1  (network on) npm ci --ignore-scripts into desk-live-deps-<package-lock hash>, once per lockfile.
 *   phase 2  docker run --rm --network none with the lab's limits and seccomp profile, the repo read-only and the
 *            dependency volume; the results come out with docker cp into test-results/live/.
 *
 * Every container is named desk-live-* and labelled with this runner; leftovers of dead runs are removed first, and
 * at most two Desk containers run at once (the VM also runs the operator's own containers).
 * Usage: npm run test:live [-- <vitest filters or flags>]
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CACHE_VOLUME,
  CONTAINER_PREFIX,
  LIVE_CONTEXT,
  OWNER_LABEL,
  RESOURCE_LABEL,
  RUNNER_LABEL,
  canStartDeskContainer,
  chromePin,
  depsVolumeName,
  imageTag,
  leftoverContainers,
  phase1RunArgs,
  phase2RunArgs,
  runnerRefusal,
} from "./lib/live.mjs";

const execFileP = promisify(execFile);

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const imageDir = join(repo, "test", "live", "image");
const resultsDir = join(repo, "test-results", "live");
const run = randomBytes(4).toString("hex");
const runner = `${hostname()}:${process.pid}`;
const DONE = "::desk-live-done::";

const MINUTE = 60_000;

/** @typedef {import("./lib/live.mjs").Container} Container */

/** The containers this run started, so an interrupted run can remove them. */
const started = new Set();
/** @type {Set<import("node:child_process").ChildProcess>} */
const children = new Set();

/**
 * The docker CLI's environment: what it needs to find its config, contexts, plugins and credential helpers, and never
 * DOCKER_HOST or DOCKER_CONTEXT, so `--context colima` alone decides where it goes.
 * @returns {NodeJS.ProcessEnv}
 */
function dockerEnv() {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const name of ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "LANG", "DOCKER_CONFIG"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Runs one docker command to completion and returns its output; a non-zero exit is a result, not an exception.
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<{ code: number; stdout: string; stderr: string }>}
 */
async function docker(args, timeoutMs) {
  try {
    const { stdout, stderr } = await execFileP("docker", args, {
      env: dockerEnv(),
      signal: AbortSignal.timeout(timeoutMs),
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failure = /** @type {{ code?: unknown; stdout?: string; stderr?: string; name?: string }} */ (err);
    if (failure.name === "AbortError") throw new Error(`docker ${args[2] ?? args[0]} timed out after ${timeoutMs} ms`);
    if (typeof failure.code !== "number") throw err;
    return { code: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/**
 * Runs one docker command with its output on this terminal.
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<number>}
 */
function dockerStreaming(args, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, {
      env: dockerEnv(),
      stdio: ["ignore", "inherit", "inherit"],
      signal: AbortSignal.timeout(timeoutMs),
    });
    children.add(child);
    child.once("error", (err) => {
      children.delete(child);
      reject(err.name === "AbortError" ? new Error(`docker ${args[2]} timed out after ${timeoutMs} ms`) : err);
    });
    child.once("close", (code) => {
      children.delete(child);
      resolvePromise(code ?? 1);
    });
  });
}

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`test:live: ${message}`);
  process.exit(1);
}

/** @param {string[]} args @param {number} timeoutMs @param {string} what */
async function must(args, timeoutMs, what) {
  const result = await docker(args, timeoutMs);
  if (result.code !== 0) fail(`${what} failed: ${result.stderr.trim().split("\n").slice(-3).join(" / ")}`);
  return result.stdout;
}

/** The colima context and the daemon behind it, for the refusal check. */
async function dockerFacts() {
  const contextOut = await docker(["context", "inspect", LIVE_CONTEXT], 10_000);
  /** @type {import("./lib/live.mjs").DockerContext | null} */
  let context = null;
  if (contextOut.code === 0) {
    const [entry] = JSON.parse(contextOut.stdout);
    const host = entry?.Endpoints?.docker?.Host;
    context = { name: LIVE_CONTEXT, endpoint: typeof host === "string" ? host : null };
  }
  /** @type {import("./lib/live.mjs").DockerInfo | null} */
  let info = null;
  if (context !== null) {
    const infoOut = await docker(["--context", LIVE_CONTEXT, "info", "--format", "{{json .}}"], 20_000);
    if (infoOut.code === 0) {
      const raw = JSON.parse(infoOut.stdout);
      info = { name: String(raw.Name ?? ""), osType: String(raw.OSType ?? ""), architecture: String(raw.Architecture ?? "") };
    }
  }
  return { context, info };
}

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {{ code?: string }} */ (err).code === "EPERM";
  }
}

/** @returns {Promise<Container[]>} every container whose name holds the prefix, in any state */
async function deskContainers() {
  const out = await must(
    ["--context", LIVE_CONTEXT, "ps", "--all", "--no-trunc", "--filter", `name=${CONTAINER_PREFIX}`, "--format", "{{json .}}"],
    20_000,
    "listing containers",
  );
  return out
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const raw = JSON.parse(line);
      /** @type {Record<string, string>} */
      const labels = {};
      for (const pair of String(raw.Labels ?? "").split(",")) {
        const eq = pair.indexOf("=");
        if (eq > 0) labels[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      return { id: String(raw.ID), name: String(raw.Names), state: String(raw.State), labels };
    });
}

/** Removes the harness's leftover containers: stopped ones, and running ones whose runner on this Mac is gone. */
async function removeLeftovers() {
  const leftovers = leftoverContainers(await deskContainers(), { host: hostname(), alive });
  for (const container of leftovers) {
    console.log(`test:live: removing leftover container ${container.name}`);
    await must(["--context", LIVE_CONTEXT, "rm", "--force", container.id], 60_000, `removing ${container.name}`);
  }
}

/** Refuses to start a third Desk container. */
async function ensureCapacity() {
  if (!canStartDeskContainer(await deskContainers())) {
    fail("two Desk live containers are already running in the Colima VM; wait for them to finish, then run again");
  }
}

/** @param {string} role */
function containerName(role) {
  const name = `${CONTAINER_PREFIX}${role}-${run}`;
  started.add(name);
  return name;
}

/** @param {string} role @returns {string[]} */
function containerFlags(role) {
  return ["--name", containerName(role), "--label", `${OWNER_LABEL}=1`, "--label", `${RUNNER_LABEL}=${runner}`];
}

/**
 * The image directory's files, without dotfiles (a Finder .DS_Store must not force a rebuild).
 * @param {string} dir
 * @returns {Promise<{ path: string; bytes: Uint8Array }[]>}
 */
async function filesUnder(dir) {
  /** @type {{ path: string; bytes: Uint8Array }[]} */
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const path = join(entry.parentPath, entry.name);
    files.push({ path: relative(dir, path), bytes: await readFile(path) });
  }
  return files;
}

/** @param {string} name */
async function volumeExists(name) {
  return (await docker(["--context", LIVE_CONTEXT, "volume", "inspect", name], 20_000)).code === 0;
}

/**
 * Creates a harness volume owned by the image's unprivileged user (uid 1000).
 * @param {string} name
 * @param {string} image an image with `install`
 */
async function createVolume(name, image) {
  await must(["--context", LIVE_CONTEXT, "volume", "create", "--label", `${RESOURCE_LABEL}=1`, name], 30_000, `creating ${name}`);
  await ensureCapacity();
  await must(
    [
      "--context", LIVE_CONTEXT, "run", "--rm", ...containerFlags("init"), "--network", "none", "--user", "0:0",
      "--volume", `${name}:/volume`, image, "install", "-d", "-o", "1000", "-g", "1000", "-m", "0755", "/volume",
    ],
    60_000,
    `initialising ${name}`,
  );
}

/**
 * Builds the image from a context that a helper container streams out of the VM: test/live/image plus the pinned
 * Chrome .deb from the cache volume. Nothing is downloaded when the .deb is cached.
 * @param {string} tag
 */
async function buildImage(tag) {
  const fetchTag = tag.replace(/^desk-live:/, "desk-live-fetch:");
  const pin = chromePin(await readFile(join(imageDir, "Dockerfile"), "utf8"));
  console.log(`test:live: building ${tag} (Chrome ${pin.deb})`);
  const fetchBuild = await dockerStreaming(
    [
      "--context", LIVE_CONTEXT, "build", "--progress", "plain", "--target", "fetch", "--tag", fetchTag,
      "--label", `${RESOURCE_LABEL}=1`, "--file", join(imageDir, "Dockerfile"), imageDir,
    ],
    30 * MINUTE,
  );
  if (fetchBuild !== 0) fail(`building ${fetchTag} failed`);

  if (!(await volumeExists(CACHE_VOLUME))) await createVolume(CACHE_VOLUME, fetchTag);
  const deb = `/cache/chrome/${pin.sha256}/${pin.deb}`;
  await ensureCapacity();
  const fetched = await dockerStreaming(
    [
      "--context", LIVE_CONTEXT, "run", "--rm", ...containerFlags("fetch"), "--user", "1000:1000",
      "--volume", `${CACHE_VOLUME}:/cache`, fetchTag, "fetch-verified", pin.url, pin.sha256, deb,
    ],
    20 * MINUTE,
  );
  if (fetched !== 0) fail(`fetching ${pin.deb} into ${CACHE_VOLUME} failed`);

  await ensureCapacity();
  const context = spawn(
    "docker",
    [
      "--context", LIVE_CONTEXT, "run", "--rm", ...containerFlags("context"), "--network", "none", "--user", "1000:1000",
      "--volume", `${imageDir}:/context:ro`, "--volume", `${CACHE_VOLUME}:/cache:ro`, fetchTag,
      "build-context", pin.sha256, pin.deb,
    ],
    { env: dockerEnv(), stdio: ["ignore", "pipe", "inherit"], signal: AbortSignal.timeout(30 * MINUTE) },
  );
  const build = spawn(
    "docker",
    ["--context", LIVE_CONTEXT, "build", "--progress", "plain", "--tag", tag, "--label", `${RESOURCE_LABEL}=1`, "-"],
    { env: dockerEnv(), stdio: ["pipe", "inherit", "inherit"], signal: AbortSignal.timeout(30 * MINUTE) },
  );
  children.add(context);
  children.add(build);
  build.stdin.on("error", (err) => {
    if (/** @type {{ code?: string }} */ (err).code !== "EPIPE") console.error(`test:live: build context: ${err.message}`);
  });
  context.stdout.pipe(build.stdin);
  /** @param {import("node:child_process").ChildProcess} child */
  const exit = (child) =>
    new Promise((resolveExit) => {
      child.once("error", () => resolveExit(1));
      child.once("close", (code) => {
        children.delete(child);
        resolveExit(code ?? 1);
      });
    });
  const [contextCode, buildCode] = await Promise.all([exit(context), exit(build)]);
  if (contextCode !== 0 || buildCode !== 0) fail(`building ${tag} failed`);
}

/** @param {string} tag */
async function ensureImage(tag) {
  if ((await docker(["--context", LIVE_CONTEXT, "image", "inspect", tag], 20_000)).code === 0) {
    console.log(`test:live: image ${tag} is current`);
    return;
  }
  await buildImage(tag);
}

/**
 * Runs one harness container with its output on this terminal and its stdin held open as the lifeline. With
 * `onDone`, the container prints `::desk-live-done:: <code>` when its work is over and waits; the runner then copies
 * the results out and closes stdin, and the container exits (and `--rm` removes it).
 * @param {string[]} args
 * @param {number} timeoutMs
 * @param {((name: string) => Promise<void>) | null} onDone
 * @returns {Promise<number>}
 */
function runHarnessContainer(args, timeoutMs, onDone) {
  const name = args[args.indexOf("--name") + 1] ?? "";
  return new Promise((resolveRun, reject) => {
    const child = spawn("docker", args, { env: dockerEnv(), stdio: ["pipe", "pipe", "inherit"] });
    children.add(child);
    child.stdin.on("error", (err) => {
      if (/** @type {{ code?: string }} */ (err).code !== "EPIPE") console.error(`test:live: ${name}: ${err.message}`);
    });
    let doneCode = /** @type {number | null} */ (null);
    let pending = "";
    const timer = setTimeout(() => {
      console.error(`test:live: ${name} ran out of time (${timeoutMs / MINUTE} minutes); stopping it`);
      child.stdin.end();
      void docker(["--context", LIVE_CONTEXT, "rm", "--force", name], 60_000);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const match = new RegExp(`^${DONE} (\\d+)\\s*$`).exec(line);
        if (match === null || doneCode !== null) continue;
        doneCode = Number(match[1]);
        const finish = onDone === null ? Promise.resolve() : onDone(name);
        finish.then(
          () => child.stdin.end(),
          (err) => {
            console.error(`test:live: copying the results out failed: ${err instanceof Error ? err.message : String(err)}`);
            child.stdin.end();
          },
        );
      }
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      children.delete(child);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      children.delete(child);
      resolveRun(doneCode ?? code ?? 1);
    });
  });
}

/**
 * Phase 1, once per package-lock.json: the dependency volume, filled by npm ci --ignore-scripts with the network on.
 * @param {string} image
 * @returns {Promise<string>} the volume's name
 */
async function ensureDependencies(image) {
  const volume = depsVolumeName(await readFile(join(repo, "package-lock.json"), "utf8"));
  if (await volumeExists(volume)) {
    await ensureCapacity();
    const ready = await docker(
      [
        "--context", LIVE_CONTEXT, "run", "--rm", ...containerFlags("check"), "--network", "none", "--user", "1000:1000",
        "--volume", `${volume}:/deps:ro`, image, "test", "-f", "/deps/.desk-live-ready",
      ],
      60_000,
    );
    if (ready.code === 0) {
      console.log(`test:live: dependencies are current (${volume})`);
      return volume;
    }
    await must(["--context", LIVE_CONTEXT, "volume", "rm", volume], 60_000, `removing the unfinished ${volume}`);
  }
  console.log(`test:live: phase 1, installing dependencies into ${volume}`);
  await createVolume(volume, image);
  if (!(await volumeExists(CACHE_VOLUME))) await createVolume(CACHE_VOLUME, image);
  await ensureCapacity();
  const code = await runHarnessContainer(
    phase1RunArgs({ name: containerName("deps"), runner, image, repo, depsVolume: volume }),
    20 * MINUTE,
    null,
  );
  if (code !== 0) fail(`phase 1 (npm ci --ignore-scripts in ${volume}) failed with exit code ${code}`);
  return volume;
}

/**
 * Copies the container's results into test-results/live/, replacing the previous run's.
 * @param {string} name
 */
async function copyResults(name) {
  await rm(resultsDir, { recursive: true, force: true });
  await mkdir(resultsDir, { recursive: true });
  await must(["--context", LIVE_CONTEXT, "cp", `${name}:/home/lab/results/.`, resultsDir], 5 * MINUTE, "docker cp");
}

/** Prints what the suite recorded: test counts and the versions it ran against. */
async function summary() {
  try {
    const report = JSON.parse(await readFile(join(resultsDir, "vitest.json"), "utf8"));
    console.log(
      `test:live: ${report.numPassedTests} passed, ${report.numFailedTests} failed, ` +
        `${report.numPendingTests + report.numTodoTests} skipped, of ${report.numTotalTests}`,
    );
  } catch {
    console.log("test:live: the suite left no vitest.json");
  }
  try {
    const environment = JSON.parse(await readFile(join(resultsDir, "environment.json"), "utf8"));
    console.log(`test:live: ${JSON.stringify(environment)}`);
  } catch {
    console.log("test:live: the suite left no environment.json");
  }
  console.log(`test:live: results in ${relative(process.cwd(), resultsDir) || resultsDir}`);
}

/** Removes this run's containers that are still there (an interrupted run). */
async function cleanUp() {
  for (const child of children) child.kill("SIGTERM");
  const ours = (await deskContainers()).filter((c) => started.has(c.name));
  for (const container of ours) await docker(["--context", LIVE_CONTEXT, "rm", "--force", container.id], 60_000);
}

for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
  process.once(signal, () => {
    console.error(`test:live: ${signal}, removing this run's containers`);
    void cleanUp().finally(() => process.exit(130));
  });
}

const { context, info } = await dockerFacts();
const refusal = runnerRefusal({ env: process.env, home: homedir(), context, info });
if (refusal !== null) fail(refusal);

const home = await realpath(homedir());
if (!(await realpath(repo)).startsWith(`${home}/`)) {
  fail(`the checkout must be under ${home}, the only tree Colima shares with the VM (other paths mount as empty directories)`);
}

await removeLeftovers();
const tag = imageTag(await filesUnder(imageDir));
await ensureImage(tag);
const depsVolume = await ensureDependencies(tag);

console.log(`test:live: phase 2, the live suite in ${tag}`);
await ensureCapacity();
const code = await runHarnessContainer(
  phase2RunArgs({ name: containerName("run"), runner, image: tag, repo, depsVolume, vitestArgs: process.argv.slice(2) }),
  30 * MINUTE,
  copyResults,
);
await summary();
await cleanUp();
process.exit(code);
