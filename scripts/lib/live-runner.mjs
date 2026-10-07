/**
 * test:live, the part of the live suite that runs outside the container (docs/IMPLEMENTATION.md §17.3). On the Mac it
 * drives `docker --context colima` and nothing else: it never starts, stops or restarts the VM, never touches a
 * container it did not start, and opens nothing on the screen. In GitHub Actions (`--ci`, on a Linux arm64 runner, as
 * live-run.yml runs it before any npm ci, so it imports nothing npm installs) it drives the runner's own engine through
 * the default context the same way, once AppArmor's user-namespace limit is lifted, with the Chrome .deb under
 * ~/.cache/desk-live/chrome, where live-run.yml caches it. Chrome, the PTYs and agent-browser run in a Linux container
 * under Xvfb.
 *
 *   image    desk-live:<hash of test/live/image>, built only when a file there changes; the pinned Chrome .deb comes
 *            from the cache (the desk-live-cache volume, or the Actions cache directory in CI), fetched once by sha256,
 *            and is streamed into the build context.
 *   phase 1  (network on) npm ci --ignore-scripts into desk-live-deps-<hash of the package files>, once per change,
 *            with only the package files mounted.
 *   phase 2  docker run --rm --network none with the lab's limits and seccomp profile, the repo's allowlisted top-level
 *            files and directories read-only (never the whole checkout) and the dependency volume; the results come
 *            out with docker cp into test-results/live/.
 *
 * Every container is named desk-live-* and labelled with this runner; leftovers of dead runs are removed first, and no
 * more Desk containers run at once than the VM's memory allows (two at most: the VM also runs the operator's own).
 * Every input (argv, environment, platform, paths, /proc/sys, the docker CLI, output) is passed in, so the offline tests
 * can drive it against a stub docker; scripts/live.mjs passes the process's own.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  CACHE_VOLUME,
  CI_CACHE_DIR,
  CI_CONTEXT,
  CONTAINER_PREFIX,
  LIVE_CONTEXT,
  OWNER_LABEL,
  RESOURCE_LABEL,
  RESULTS,
  RESULTS_DIR,
  USERNS_LIMIT,
  cacheMount,
  canStartDeskContainer,
  chromeCacheFile,
  chromePin,
  containerFlags,
  deskContainerCap,
  depsVolumeName,
  dockerTime,
  doneCode,
  engineRefusal,
  hostRefusal,
  imageTag,
  imagesToPrune,
  installInputs,
  leftoverContainers,
  mountFlag,
  phase1RunArgs,
  phase2RepoEntries,
  phase2RunArgs,
  runnerArgs,
  userNamespaceRefusal,
  volumesToPrune,
} from "./live.mjs";
import { readResultFile, unsafeResultEntries } from "./live-results.mjs";

const MINUTE = 60_000;
const SIGNALS = /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"]);

/** @typedef {import("./live.mjs").Env} Env */
/** @typedef {import("./live.mjs").Container} Container */
/** @typedef {import("./live.mjs").CacheStore} CacheStore */
/** @typedef {import("./live.mjs").DockerContext} DockerContext */
/** @typedef {import("./live.mjs").DockerInfo} DockerInfo */
/** @typedef {{ ok: true } | { ok: false; reason: string }} Copied */
/** @typedef {import("node:child_process").ChildProcess} ChildProcess */
/**
 * @typedef {{
 *   argv: readonly string[];
 *   env: Env;
 *   platform: string;
 *   arch: string;
 *   repo: string;
 *   home: string;
 *   host: string;
 *   pid: number;
 *   docker: string;
 *   procSys: string;
 *   out: (text: string) => void;
 *   err: (text: string) => void;
 *   signals: { on(signal: string, listener: () => void): unknown; off(signal: string, listener: () => void): unknown } | null;
 *   now: () => number;
 * }} LiveOptions
 */

/** A failure the runner reports in one line. */
class RunFailure extends Error {}

/** The run is being abandoned (a second Ctrl+C): no new docker command starts. */
class Abandoned extends Error {}

/** @param {unknown} err */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/** @param {string} text the last lines of a docker error, on one line */
function lastLines(text) {
  return text.trim().split("\n").slice(-3).join(" / ");
}

/** @param {string} text @returns {unknown} */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  return typeof value === "object" && value !== null ? /** @type {Record<string, unknown>} */ (value) : {};
}

/** @param {string} path */
async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (err) {
    if (/** @type {{ code?: string }} */ (err).code === "ENOENT") return false;
    throw err;
  }
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

/**
 * `docker ps --format '{{json .}}'` lines as containers.
 * @param {string} text
 * @returns {Container[]}
 */
function parseContainers(text) {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const raw = record(parseJson(line));
      /** @type {Record<string, string>} */
      const labels = {};
      for (const pair of String(raw.Labels ?? "").split(",")) {
        const eq = pair.indexOf("=");
        if (eq > 0) labels[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      return { id: String(raw.ID ?? ""), name: String(raw.Names ?? ""), state: String(raw.State ?? ""), labels };
    });
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

/**
 * Runs the live suite and returns the exit code: the phase-2 container's status once its results are safely out, 1 for
 * any failure before that or a run without results, 130 after an interrupt. It never calls process.exit.
 * @param {LiveOptions} options
 * @returns {Promise<number>}
 */
export async function runLive(options) {
  const { env, platform, arch, repo, home, host, pid, out, err, signals, now } = options;
  const { ci, vitestArgs } = runnerArgs(options.argv);
  const context = ci ? CI_CONTEXT : LIVE_CONTEXT;
  const run = randomBytes(4).toString("hex");
  const runner = `${host}:${pid}`;
  const imageDir = join(repo, "test", "live", "image");
  const resultsDir = join(repo, ...RESULTS_DIR.split("/"));
  /** @type {CacheStore} */
  const cache = ci ? { kind: "dir", path: join(home, CI_CACHE_DIR) } : { kind: "volume", name: CACHE_VOLUME };
  const cacheName = ci ? "the Actions cache directory" : CACHE_VOLUME;

  /** The containers this run started, by name, so an interrupted run removes them. */
  const started = new Set();
  /** @type {Set<ChildProcess>} */
  const children = new Set();
  let stopping = false;
  let interrupted = false;
  let cachePrepared = false;
  let cap = 1;
  /** @type {{ stop(): void; stopping(): boolean } | null} */
  let suite = null;
  /** @type {Promise<void>} */
  let abandoned = Promise.resolve();

  /** @param {string} text */
  const say = (text) => out(`test:live: ${text}\n`);
  /** @param {string} text */
  const warn = (text) => err(`test:live: ${text}\n`);

  /**
   * The docker CLI's environment: what it needs to find its config, contexts, plugins and credential helpers, and
   * never DOCKER_HOST or DOCKER_CONTEXT, so `--context` alone decides where it goes.
   * @returns {NodeJS.ProcessEnv}
   */
  const dockerEnv = () => {
    /** @type {NodeJS.ProcessEnv} */
    const picked = {};
    for (const name of ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "LANG", "DOCKER_CONFIG"]) {
      const value = env[name];
      if (value !== undefined) picked[name] = value;
    }
    return picked;
  };

  /** @param {string[]} args @returns {string[]} */
  const onEngine = (args) => ["--context", context, ...args];

  /**
   * A spawn failure as one line: docker missing, or a timeout.
   * @param {unknown} failure
   * @param {string} what
   * @param {number} timeoutMs
   */
  const spawnFailure = (failure, what, timeoutMs) => {
    const { code, name } = /** @type {{ code?: string; name?: string }} */ (failure);
    if (code === "ENOENT") return new RunFailure(`docker is not installed or not on PATH (${options.docker})`);
    if (name === "AbortError") return new RunFailure(`docker ${what} timed out after ${Math.round(timeoutMs / 1000)} s`);
    return new RunFailure(`docker ${what}: ${messageOf(failure)}`);
  };

  /**
   * Starts one docker command with its argv as given; while the run is abandoned, only a `force`d one starts.
   * @param {string[]} argv
   * @param {{ stdin: "ignore" | "pipe"; timeoutMs?: number; force?: boolean }} how
   */
  const start = (argv, how) => {
    if (stopping && how.force !== true) throw new Abandoned();
    const child = spawn(options.docker, argv, {
      env: dockerEnv(),
      stdio: [how.stdin, "pipe", "pipe"],
      ...(how.timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(how.timeoutMs) }),
    });
    children.add(child);
    child.once("close", () => children.delete(child));
    return child;
  };

  /**
   * Runs one docker command to completion and returns its output; a non-zero exit is a result, not an exception.
   * @param {string[]} args without the context
   * @param {number} timeoutMs
   * @param {{ bare?: boolean; force?: boolean }} [how] `bare`: no `--context`; `force`: even while abandoning
   * @returns {Promise<{ code: number; stdout: string; stderr: string }>}
   */
  const docker = (args, timeoutMs, how = {}) =>
    new Promise((resolve, reject) => {
      const child = start(how.bare === true ? args : onEngine(args), { stdin: "ignore", timeoutMs, force: how.force === true });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", (failure) => reject(spawnFailure(failure, args[0] ?? "", timeoutMs)));
      child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });

  /** @param {string[]} args @param {number} timeoutMs @param {string} what */
  const must = async (args, timeoutMs, what) => {
    const result = await docker(args, timeoutMs);
    if (result.code !== 0) throw new RunFailure(`${what} failed: ${lastLines(result.stderr)}`);
    return result.stdout;
  };

  /**
   * Runs one docker command with its output on this run's output, and returns its exit code.
   * @param {string[]} argv the full argv
   * @param {number} timeoutMs
   * @returns {Promise<number>}
   */
  const streamed = (argv, timeoutMs) =>
    new Promise((resolve, reject) => {
      const child = start(argv, { stdin: "ignore", timeoutMs });
      child.stdout?.setEncoding("utf8").on("data", out);
      child.stderr?.setEncoding("utf8").on("data", err);
      child.once("error", (failure) => reject(spawnFailure(failure, argv[2] ?? "", timeoutMs)));
      child.once("close", (code) => resolve(code ?? 1));
    });

  /**
   * Runs one harness container with its output on this run's output and its stdin held open as the lifeline: a
   * container whose runner died sees stdin close and ends itself.
   * @param {string[]} argv the full argv
   * @param {string} name
   * @param {number} timeoutMs
   * @returns {Promise<number>}
   */
  const lifeline = (argv, name, timeoutMs) =>
    new Promise((resolve, reject) => {
      const child = start(argv, { stdin: "pipe" });
      child.stdin?.on("error", () => undefined);
      child.stdout?.setEncoding("utf8").on("data", out);
      child.stderr?.setEncoding("utf8").on("data", err);
      const timer = setTimeout(() => {
        warn(`${name} ran out of time (${timeoutMs / MINUTE} minutes); stopping it`);
        child.stdin?.end();
        docker(["rm", "--force", name], MINUTE, { force: true }).catch(() => undefined);
      }, timeoutMs);
      child.once("error", (failure) => {
        clearTimeout(timer);
        reject(spawnFailure(failure, "run", timeoutMs));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });

  /** @param {number} code */
  const startHint = (code) =>
    code === 125 ? " (docker could not start the container; on the Mac, Colima shares only your home directory)" : "";

  /** The colima context (Mac only) and the engine behind it, for the refusal check. */
  const dockerFacts = async () => {
    /** @type {DockerContext | null} */
    let found = null;
    if (!ci) {
      const inspected = await docker(["context", "inspect", LIVE_CONTEXT], 10_000, { bare: true });
      if (inspected.code === 0) {
        const parsed = parseJson(inspected.stdout);
        const entry = record(Array.isArray(parsed) ? /** @type {unknown[]} */ (parsed)[0] : null);
        const hostValue = record(record(entry.Endpoints).docker).Host;
        found = { name: LIVE_CONTEXT, endpoint: typeof hostValue === "string" ? hostValue : null };
      }
      if (found === null) return { context: found, info: null };
    }
    /** @type {DockerInfo | null} */
    let info = null;
    const answered = await docker(["info", "--format", "{{json .}}"], 20_000);
    if (answered.code === 0) {
      const raw = record(parseJson(answered.stdout));
      info = {
        name: String(raw.Name ?? ""),
        osType: String(raw.OSType ?? ""),
        architecture: String(raw.Architecture ?? ""),
        memTotal: Number(raw.MemTotal ?? Number.NaN),
      };
    }
    return { context: found, info };
  };

  /** @param {{ force?: boolean }} [how] @returns {Promise<Container[]>} the containers whose name holds the prefix */
  const deskContainers = async (how = {}) => {
    const listed = await docker(
      ["ps", "--all", "--no-trunc", "--filter", `name=${CONTAINER_PREFIX}`, "--format", "{{json .}}"],
      20_000,
      how,
    );
    if (listed.code !== 0) throw new RunFailure(`listing containers failed: ${lastLines(listed.stderr)}`);
    return parseContainers(listed.stdout);
  };

  /** Removes the harness's leftover containers; one docker already removed is not a failure. */
  const removeLeftovers = async () => {
    for (const container of leftoverContainers(await deskContainers(), { host, alive, now: now() })) {
      say(`removing leftover container ${container.name}`);
      const removed = await docker(["rm", "--force", container.id], MINUTE);
      if (removed.code !== 0) warn(`could not remove ${container.name}, perhaps already gone: ${lastLines(removed.stderr)}`);
    }
  };

  /** Refuses to start a container beyond what the VM's memory allows. */
  const ensureCapacity = async () => {
    if (!canStartDeskContainer(await deskContainers(), cap)) {
      throw new RunFailure(
        cap === 1
          ? "another Desk live container is running, and this VM has memory for one; wait for it to finish, then run again"
          : `${cap} Desk live containers are already running; wait for them to finish, then run again`,
      );
    }
  };

  /** @param {string} role */
  const containerName = (role) => {
    const name = `${CONTAINER_PREFIX}${role}-${run}`;
    started.add(name);
    return name;
  };

  /** @param {string} role @returns {string[]} */
  const flagsFor = (role) => containerFlags({ name: containerName(role), runner, started: now() });

  /** @param {string} name */
  const volumeExists = async (name) => (await docker(["volume", "inspect", name], 20_000)).code === 0;

  /**
   * Gives the image's unprivileged user (uid 1000) a volume or the CI cache directory, as root in a throwaway container.
   * @param {CacheStore} store
   * @param {string} image an image with `install` and `chown`
   * @param {boolean} recursive the CI cache directory: files the Actions cache restored belong to the runner's user
   */
  const initOwnership = async (store, image, recursive) => {
    await ensureCapacity();
    const command = recursive ? ["chown", "-R", "1000:1000", "/volume"] : ["install", "-d", "-o", "1000", "-g", "1000", "-m", "0755", "/volume"];
    await must(
      [
        "run", "--rm", "--pull", "never", ...flagsFor("init"), "--network", "none", "--user", "0:0",
        "--security-opt", "no-new-privileges", ...cacheMount(store, "/volume"), image, ...command,
      ],
      2 * MINUTE,
      `preparing ${store.kind === "volume" ? store.name : cacheName}`,
    );
  };

  /** @param {string} name @param {string} image */
  const createVolume = async (name, image) => {
    await must(["volume", "create", "--label", `${RESOURCE_LABEL}=1`, name], 30_000, `creating ${name}`);
    await initOwnership({ kind: "volume", name }, image, false);
  };

  /** The cache volume on the Mac, or the Actions cache directory in CI, owned by the image's user. @param {string} image */
  const prepareCache = async (image) => {
    if (cachePrepared) return;
    if (cache.kind === "volume") {
      if (!(await volumeExists(cache.name))) await createVolume(cache.name, image);
    } else {
      await mkdir(cache.path, { recursive: true });
      await initOwnership(cache, image, true);
    }
    cachePrepared = true;
  };

  /**
   * After a build: removes the harness's older images (by label and name), keeping the newest other one. Best effort.
   * @param {string} tag
   */
  const pruneImages = async (tag) => {
    /** @type {Map<string, { repository: string; tag: string; createdAt: number; labels: Record<string, string> }>} */
    const images = new Map();
    for (const label of [RESOURCE_LABEL, OWNER_LABEL]) {
      const listed = await docker(["image", "ls", "--filter", `label=${label}=1`, "--format", "{{json .}}"], 20_000);
      if (listed.code !== 0) return;
      for (const line of listed.stdout.split("\n").filter((l) => l.trim() !== "")) {
        const raw = record(parseJson(line));
        const image = {
          repository: String(raw.Repository ?? ""),
          tag: String(raw.Tag ?? ""),
          createdAt: dockerTime(String(raw.CreatedAt ?? "")) ?? 0,
          labels: { [label]: "1" },
        };
        images.set(`${image.repository}:${image.tag}`, image);
      }
    }
    for (const reference of imagesToPrune([...images.values()], tag)) {
      const removed = await docker(["image", "rm", reference], 2 * MINUTE);
      if (removed.code === 0) say(`removed the old image ${reference}`);
      else warn(`kept the old image ${reference}: ${lastLines(removed.stderr)}`);
    }
  };

  /**
   * After a new dependency volume is installed: removes older ones (by label and name), keeping the newest other one;
   * docker refuses one a container still uses. Best effort.
   * @param {string} current
   */
  const pruneVolumes = async (current) => {
    const listed = await docker(["volume", "ls", "--filter", "name=desk-live-deps-", "--format", "{{.Name}}"], 20_000);
    const names = listed.code === 0 ? listed.stdout.split("\n").map((n) => n.trim()).filter((n) => n !== "") : [];
    if (names.length === 0) return;
    const inspected = await docker(["volume", "inspect", ...names], 20_000);
    if (inspected.code !== 0) return;
    const parsed = parseJson(inspected.stdout);
    const volumes = (Array.isArray(parsed) ? parsed : []).map((value) => {
      const raw = record(value);
      /** @type {Record<string, string>} */
      const labels = {};
      for (const [key, label] of Object.entries(record(raw.Labels))) labels[key] = String(label);
      return { name: String(raw.Name ?? ""), createdAt: dockerTime(String(raw.CreatedAt ?? "")) ?? 0, labels };
    });
    for (const name of volumesToPrune(volumes, current)) {
      const removed = await docker(["volume", "rm", name], MINUTE);
      if (removed.code === 0) say(`removed the old dependency volume ${name}`);
      else warn(`kept the old dependency volume ${name}: ${lastLines(removed.stderr)}`);
    }
  };

  /**
   * Builds the image from a context that a helper container streams from the image directory and the cache: the
   * pinned Chrome .deb never leaves the cache except into the build. Nothing is downloaded when the .deb is cached.
   * @param {string} tag
   */
  const buildImage = async (tag) => {
    const fetchTag = tag.replace(/^desk-live:/, "desk-live-fetch:");
    const pin = chromePin(await readFile(join(imageDir, "Dockerfile"), "utf8"));
    say(`building ${tag} (Chrome ${pin.deb})`);
    const fetchBuild = await streamed(
      onEngine([
        "build", "--progress", "plain", "--target", "fetch", "--tag", fetchTag, "--label", `${RESOURCE_LABEL}=1`,
        "--file", join(imageDir, "Dockerfile"), imageDir,
      ]),
      30 * MINUTE,
    );
    if (fetchBuild !== 0) throw new RunFailure(`building ${fetchTag} failed`);

    await prepareCache(fetchTag);
    await ensureCapacity();
    const fetched = await streamed(
      onEngine([
        "run", "--rm", "--pull", "never", ...flagsFor("fetch"), "--user", "1000:1000", "--security-opt", "no-new-privileges",
        ...cacheMount(cache), fetchTag, "fetch-verified", pin.url, pin.sha256, `/cache/${chromeCacheFile(pin)}`,
      ]),
      20 * MINUTE,
    );
    if (fetched !== 0) {
      throw new RunFailure(
        `fetching ${pin.deb} into ${cacheName} failed; if Google pruned that build from its pool, bump CHROME_DEB and CHROME_SHA256 in test/live/image/Dockerfile`,
      );
    }

    await ensureCapacity();
    const contextArgs = onEngine([
      "run", "--rm", "--pull", "never", ...flagsFor("context"), "--network", "none", "--user", "1000:1000",
      "--security-opt", "no-new-privileges", ...mountFlag("bind", imageDir, "/context", true),
      ...cacheMount(cache, "/cache", true), fetchTag, "build-context", pin.sha256, pin.deb,
    ]);
    const helper = start(contextArgs, { stdin: "ignore", timeoutMs: 30 * MINUTE });
    const build = start(onEngine(["build", "--progress", "plain", "--tag", tag, "--label", `${RESOURCE_LABEL}=1`, "-"]), {
      stdin: "pipe",
      timeoutMs: 30 * MINUTE,
    });
    build.stdin?.on("error", (failure) => {
      if (/** @type {{ code?: string }} */ (failure).code !== "EPIPE") warn(`build context: ${messageOf(failure)}`);
    });
    if (helper.stdout !== null && build.stdin !== null) helper.stdout.pipe(build.stdin);
    helper.stderr?.setEncoding("utf8").on("data", err);
    build.stdout?.setEncoding("utf8").on("data", out);
    build.stderr?.setEncoding("utf8").on("data", err);
    /** @param {ChildProcess} child @returns {Promise<number>} */
    const exit = (child) =>
      new Promise((resolve) => {
        child.once("error", () => resolve(1));
        child.once("close", (code) => resolve(code ?? 1));
      });
    const [contextCode, buildCode] = await Promise.all([exit(helper), exit(build)]);
    if (contextCode !== 0 || buildCode !== 0) throw new RunFailure(`building ${tag} failed`);
    await pruneImages(tag);
  };

  /** @param {string} tag */
  const ensureImage = async (tag) => {
    if ((await docker(["image", "inspect", tag], 20_000)).code === 0) {
      say(`image ${tag} is current`);
      return;
    }
    await buildImage(tag);
  };

  /**
   * Whether the dependency volume is complete. Only `test -f`'s own "no" counts as not ready; any other failure is
   * docker's, and stops the run without touching the volume.
   * @param {string} volume
   * @param {string} image
   */
  const depsReady = async (volume, image) => {
    await ensureCapacity();
    const check = await docker(
      [
        "run", "--rm", "--pull", "never", ...flagsFor("check"), "--network", "none", "--user", "1000:1000",
        "--security-opt", "no-new-privileges", ...mountFlag("volume", volume, "/deps", true), image,
        "test", "-f", "/deps/.desk-live-ready",
      ],
      MINUTE,
    );
    if (check.code === 0) return true;
    if (check.code === 1) return false;
    throw new RunFailure(`checking ${volume} failed (exit ${check.code})${startHint(check.code)}: ${lastLines(check.stderr)}`);
  };

  /**
   * Phase 1, once per change to the package files: the dependency volume, filled by npm ci --ignore-scripts with the
   * network on. An unfinished volume is installed again in place, under install.mjs's lock, never removed.
   * @param {string} image
   * @returns {Promise<string>} the volume's name
   */
  const ensureDependencies = async (image) => {
    const inputs = installInputs(await readFile(join(repo, "package.json"), "utf8"), await isFile(join(repo, ".npmrc")));
    if (!inputs.ok) throw new RunFailure(inputs.reason);
    const files = await Promise.all(inputs.files.map(async (path) => ({ path, bytes: await readFile(join(repo, path)) })));
    const volume = depsVolumeName(files);
    if (await volumeExists(volume)) {
      if (await depsReady(volume, image)) {
        say(`dependencies are current (${volume})`);
        return volume;
      }
      await initOwnership({ kind: "volume", name: volume }, image, false);
    } else {
      await createVolume(volume, image);
    }
    say(`phase 1, installing dependencies into ${volume}`);
    await prepareCache(image);
    await ensureCapacity();
    const name = containerName("deps");
    const code = await lifeline(
      phase1RunArgs({ context, name, runner, started: now(), image, repo, installFiles: inputs.files, depsVolume: volume, cache }),
      name,
      20 * MINUTE,
    );
    if (code !== 0) throw new RunFailure(`phase 1 (npm ci --ignore-scripts in ${volume}) failed with exit code ${code}${startHint(code)}`);
    await pruneVolumes(volume);
    return volume;
  };

  /**
   * Copies the container's results into test-results/live/, then checks that what landed holds only plain files and
   * directories, whether or not the copy finished; anything else (a link docker cp kept) deletes it all unread, and so
   * does a check that cannot run.
   * @param {string} name
   * @returns {Promise<Copied>}
   */
  const copyResults = async (name) => {
    /** @type {Copied} */
    let copied;
    try {
      await rm(resultsDir, { recursive: true, force: true });
      await mkdir(resultsDir, { recursive: true });
      const cp = await docker(["cp", `${name}:${RESULTS}/.`, resultsDir], 5 * MINUTE);
      copied = cp.code === 0 ? { ok: true } : { ok: false, reason: `docker cp failed: ${lastLines(cp.stderr)}` };
    } catch (failure) {
      copied = { ok: false, reason: `copying the results out failed: ${messageOf(failure)}` };
    }
    const unsafe = await unsafeResultEntries(resultsDir).then(
      (entries) => entries.length,
      () => -1,
    );
    if (unsafe === 0) return copied;
    await rm(resultsDir, { recursive: true, force: true }).catch(() => undefined);
    if (unsafe < 0) return copied.ok ? { ok: false, reason: "the results could not be checked; they were deleted unread" } : copied;
    const what = unsafe === 1 ? "1 entry that is" : `${unsafe} entries that are`;
    return { ok: false, reason: `the container's results held ${what} not a plain file or directory; they were deleted unread` };
  };

  /**
   * Phase 2's container: its output streams here; when this run's done line appears, the results are copied out and
   * stdin, the lifeline, is closed, and the container exits with the suite's code. A stop request (the timeout or the
   * first Ctrl+C) sends SIGTERM to the suite inside the container, which then prints its done line as usual.
   * @param {string[]} argv
   * @param {string} name
   * @returns {Promise<{ code: number; done: boolean; copied: Copied | null }>}
   */
  const phase2 = (argv, name) =>
    new Promise((resolve, reject) => {
      const child = start(argv, { stdin: "pipe" });
      child.stdin?.on("error", () => undefined);
      child.stderr?.setEncoding("utf8").on("data", err);
      let done = false;
      let pending = "";
      /** @type {Promise<Copied | null> | null} */
      let copying = null;
      let stopRequested = false;
      /** @type {NodeJS.Timeout | undefined} */
      let grace;
      const stop = () => {
        if (stopRequested) return;
        stopRequested = true;
        docker(["kill", "--signal", "SIGTERM", name], 30_000, { force: true }).catch(() => undefined);
        grace = setTimeout(() => {
          warn(`${name} did not stop within 2 minutes; removing it`);
          child.stdin?.end();
          docker(["rm", "--force", name], MINUTE, { force: true }).catch(() => undefined);
        }, 2 * MINUTE);
      };
      suite = { stop, stopping: () => stopRequested };
      const timer = setTimeout(() => {
        warn(`${name} ran out of time (30 minutes); stopping the suite`);
        stop();
      }, 30 * MINUTE);
      child.stdout?.setEncoding("utf8").on("data", (/** @type {string} */ chunk) => {
        out(chunk);
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (done || doneCode(line, run) === null) continue;
          done = true;
          // An abandoned run copies nothing more; the container's removal is under way.
          copying = stopping ? Promise.resolve(null) : copyResults(name).finally(() => child.stdin?.end());
        }
      });
      child.once("error", (failure) => {
        clearTimeout(timer);
        clearTimeout(grace);
        suite = null;
        reject(spawnFailure(failure, "run", 0));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        clearTimeout(grace);
        suite = null;
        void (copying ?? Promise.resolve(null)).then((copied) => resolve({ code: code ?? 1, done, copied }));
      });
    });

  /** Prints what the suite recorded: test counts and the versions it ran against. Files are read without links. */
  const summary = async () => {
    const report = record(parseJson((await readResultFile(join(resultsDir, "vitest.json"))) ?? ""));
    if (typeof report.numTotalTests === "number") {
      const skipped = Number(report.numPendingTests ?? 0) + Number(report.numTodoTests ?? 0);
      say(`${Number(report.numPassedTests)} passed, ${Number(report.numFailedTests)} failed, ${skipped} skipped, of ${report.numTotalTests}`);
    } else {
      say("the suite left no vitest.json");
    }
    const environment = parseJson((await readResultFile(join(resultsDir, "environment.json"))) ?? "");
    say(environment === null ? "the suite left no environment.json" : JSON.stringify(environment));
    say(`results in ${relative(repo, resultsDir)}`);
  };

  /**
   * The checkout's top-level entries phase 2 mounts. The directory listing does not follow links: a symbolic link is
   * neither a file nor a directory in it, so it is never mounted.
   * @returns {Promise<string[]>}
   */
  const repoEntries = async () =>
    phase2RepoEntries(
      (await readdir(repo, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        kind: entry.isFile() ? "file" : entry.isDirectory() ? "dir" : "other",
      })),
    );

  /**
   * Phase 2: this run's results only. Exits with the container's status once its results are out; a run that ended
   * before its done line, or whose results could not be copied out, fails.
   * @param {string} image
   * @param {string} depsVolume
   */
  const runSuite = async (image, depsVolume) => {
    say(`phase 2, the live suite in ${image}`);
    await ensureCapacity();
    // Only a run that may start its suite clears the previous results, so a refused run leaves another's alone.
    await rm(resultsDir, { recursive: true, force: true });
    const name = containerName("run");
    const mounted = await repoEntries();
    const { code, done, copied } = await phase2(
      phase2RunArgs({ context, name, runner, started: now(), image, repo, repoEntries: mounted, depsVolume, run, vitestArgs }),
      name,
    );
    if (stopping) return 130;
    if (!done) {
      say(`no results: the container ended before the suite finished (exit ${code})${startHint(code)}`);
      return code === 0 ? 1 : code;
    }
    if (copied === null || !copied.ok) {
      warn(copied === null ? "the results were not copied out" : copied.reason);
      return code === 0 ? 1 : code;
    }
    await summary();
    return code;
  };

  /** Removes this run's containers that are still there. */
  const removeStarted = async () => {
    if (started.size === 0) return;
    const ours = (await deskContainers({ force: true }).catch(() => [])).filter((c) => started.has(c.name));
    for (const container of ours) await docker(["rm", "--force", container.id], MINUTE, { force: true }).catch(() => undefined);
  };

  /**
   * The one way out on a second interrupt, or an interrupt outside phase 2: no new docker command starts, the running
   * ones are stopped, and this run's containers are removed.
   * @param {string} signal
   */
  const abandon = async (signal) => {
    stopping = true;
    warn(`${signal}, removing this run's containers`);
    for (const child of children) child.kill("SIGTERM");
    await removeStarted();
  };

  /** @param {string} signal */
  const onSignal = (signal) => {
    interrupted = true;
    if (stopping) return;
    if (suite !== null && !suite.stopping()) {
      warn(`${signal}: stopping the suite; its results are copied out first (${signal} again abandons them)`);
      suite.stop();
      return;
    }
    abandoned = abandon(signal);
  };
  const listeners = SIGNALS.map((signal) => /** @type {const} */ ([signal, () => onSignal(signal)]));
  for (const [signal, listener] of listeners) signals?.on(signal, listener);

  /**
   * A sysctl of the host (the CI runner) by its dotted name, or `null` when this kernel has none.
   * @param {string} name
   * @returns {Promise<string | null>}
   */
  const sysctl = async (name) => {
    const path = join(options.procSys, ...name.split("."));
    try {
      return await readFile(path, "utf8");
    } catch (failure) {
      if (/** @type {{ code?: string }} */ (failure).code === "ENOENT") return null;
      throw new RunFailure(`reading ${path} failed: ${messageOf(failure)}`);
    }
  };

  const main = async () => {
    const homeReal = await realpath(home).catch(() => home);
    const repoReal = await realpath(repo);
    const hostReason = hostRefusal({ ci, env, platform, arch, homeReal, repoReal });
    if (hostReason !== null) throw new RunFailure(hostReason);
    // On the Mac the limit, if any, is the Colima VM's, where Chrome's sandbox is measured to work (§17.3).
    if (ci) {
      const usernsReason = userNamespaceRefusal(await sysctl(USERNS_LIMIT));
      if (usernsReason !== null) throw new RunFailure(usernsReason);
    }
    const facts = await dockerFacts();
    const engineReason = engineRefusal({ ci, env, home, context: facts.context, info: facts.info });
    if (engineReason !== null) throw new RunFailure(engineReason);
    cap = deskContainerCap(facts.info?.memTotal ?? Number.NaN);
    await removeLeftovers();
    const tag = imageTag(await filesUnder(imageDir));
    await ensureImage(tag);
    const depsVolume = await ensureDependencies(tag);
    return runSuite(tag, depsVolume);
  };

  try {
    const code = await main();
    if (stopping) await abandoned;
    return interrupted ? 130 : code;
  } catch (failure) {
    if (stopping || failure instanceof Abandoned) {
      await abandoned;
      return 130;
    }
    warn(failure instanceof RunFailure ? failure.message : `failed: ${messageOf(failure)}`);
    return interrupted ? 130 : 1;
  } finally {
    for (const [signal, listener] of listeners) signals?.off(signal, listener);
    if (!stopping) await removeStarted();
  }
}
