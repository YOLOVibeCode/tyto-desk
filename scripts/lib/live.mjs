/**
 * The live harness's decisions (docs/IMPLEMENTATION.md §17.3), kept pure so `npm test` checks them offline: where the
 * runner and the suite may run, which containers are leftovers, how many Desk containers may run at once, how volumes
 * and images are named and pruned, the docker argv of both phases, the suite's done line, and which repo files the
 * container sees. scripts/lib/live-runner.mjs (the Mac or CI side) and test/live/harness/*.mjs (the container side) use
 * them. Node builtins only, and nothing but this file: phase 1 mounts it alone, before any dependency is installed.
 */
import { createHash } from "node:crypto";

/** The docker context the runner drives on the Mac. */
export const LIVE_CONTEXT = "colima";
/** In GitHub Actions: the runner's own engine at its default socket (the runner strips DOCKER_HOST). */
export const CI_CONTEXT = "default";

/**
 * Every container the harness starts is named `desk-live-<role>-<run>` and carries the container labels. Images and
 * volumes carry only RESOURCE_LABEL: an image's labels reach every container made from it, so a container is the
 * harness's only by its name, the owner label and a runner label, which only the runner sets. Volumes made before the
 * resource label existed carry the owner label; docker sets a volume's labels only when it creates the volume.
 */
export const CONTAINER_PREFIX = "desk-live-";
export const OWNER_LABEL = "com.noctusoft.desk-live";
export const RUNNER_LABEL = "com.noctusoft.desk-live.runner";
export const STARTED_LABEL = "com.noctusoft.desk-live.started";
export const RESOURCE_LABEL = "com.noctusoft.desk-live.resource";

/** The VM also runs the operator's own containers: never more than two Desk containers, fewer on a small VM. */
export const MAX_DESK_CONTAINERS = 2;
/** Phase 2's memory limit, which also covers its 1 GiB /dev/shm. */
export const PHASE2_MEMORY_BYTES = 3 * 1024 ** 3;
/** What the VM keeps for the operator's containers and itself beyond the Desk containers' limits. */
export const VM_HEADROOM_BYTES = 1.5 * 1024 ** 3;
/** A stopped container another host's runner left is a leftover only once it is older than any phase can run. */
export const STALE_AFTER_MS = 2 * 60 * 60_000;

/** The Chrome .deb (by sha256) and npm's cache, on the Mac. Google prunes old builds from its pool, so the .deb is kept. */
export const CACHE_VOLUME = "desk-live-cache";
/**
 * The same cache in GitHub Actions, under the runner's HOME. live-run.yml restores its `chrome/` directory from, and on
 * main saves it to, the Actions cache under the key `desk-live-chrome-<sha256>` (IMPLEMENTATION D64).
 */
export const CI_CACHE_DIR = ".cache/desk-live";
/** Where a cache keeps the pinned Chrome .deb: `chrome/<sha256>/<deb>`, which the image's build-context reads too. */
export const CHROME_CACHE_DIR = "chrome";

/** Where each run's results land, relative to the checkout; live-run.yml uploads `test-results/`. */
export const RESULTS_DIR = "test-results/live";

/**
 * The sysctl with which Ubuntu 24.04's AppArmor limits unprivileged user namespaces. Chrome's sandbox needs them, so on
 * GitHub's runner live-run.yml lifts the limit before the suite; the suite never runs Chrome with --no-sandbox.
 */
export const USERNS_LIMIT = "kernel.apparmor_restrict_unprivileged_userns";

/**
 * Where the container sees the repo's files (read-only: phase 1's package files, phase 2's allowlisted top-level
 * entries), where the suite runs from, and where it leaves its results.
 */
export const SRC = "/src";
export const WORK = "/work";
export const RESULTS = "/home/lab/results";
/** Xvfb's framebuffer, as an XWD file the live tests read to see what is on the screen. */
export const FRAMEBUFFER_DIR = "/tmp/desk-xvfb";
export const FRAMEBUFFER = `${FRAMEBUFFER_DIR}/Xvfb_screen0`;

/** Phase 1 mounts these two scripts beside the package files; nothing else of the repo. */
const PHASE1_SCRIPTS = ["scripts/lib/live.mjs", "test/live/harness/install.mjs"];

const DONE_MARKER = "::desk-live-done::";

/** @typedef {{ name: string; endpoint: string | null }} DockerContext */
/** @typedef {{ name: string; osType: string; architecture: string; memTotal: number }} DockerInfo */
/** @typedef {Readonly<Record<string, string | undefined>>} Env */
/**
 * @typedef {{
 *   ci: boolean; env: Env; platform: string; arch: string;
 *   home: string; homeReal: string; repoReal: string;
 *   context: DockerContext | null; info: DockerInfo | null;
 * }} RunnerInput
 */
/** @typedef {{ id: string; name: string; state: string; labels: Readonly<Record<string, string>> }} Container */
/** @typedef {{ kind: "volume"; name: string } | { kind: "dir"; path: string }} CacheStore */
/** @typedef {typeof LIVE_CONTEXT | typeof CI_CONTEXT} EngineContext */

/** @param {string} path */
function hasDotSegment(path) {
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

/**
 * The runner's own flags: `--ci` (GitHub Actions), wherever it appears. Everything else goes to vitest.
 * @param {readonly string[]} argv
 * @returns {{ ci: boolean; vitestArgs: string[] }}
 */
export function runnerArgs(argv) {
  return { ci: argv.includes("--ci"), vitestArgs: argv.filter((arg) => arg !== "--ci") };
}

/**
 * The directories Colima keeps its profiles in: `$COLIMA_HOME`, `~/.colima`, and `~/.config/colima`.
 * @param {string} home
 * @param {Env} env
 */
function colimaHomes(home, env) {
  const base = home.replace(/\/+$/, "");
  const homes = [`${base}/.colima`, `${base}/.config/colima`];
  if (env.COLIMA_HOME) homes.unshift(env.COLIMA_HOME.replace(/\/+$/, ""));
  return homes;
}

/**
 * Whether a docker endpoint is a Colima profile's socket: `unix://<colima home>/<profile>/docker.sock`.
 * @param {string | null} endpoint
 * @param {string} home
 * @param {Env} env
 */
function isColimaSocket(endpoint, home, env) {
  if (endpoint === null || !endpoint.startsWith("unix:///")) return false;
  const path = endpoint.slice("unix://".length);
  if (hasDotSegment(path)) return false;
  return colimaHomes(home, env).some((dir) => {
    if (!path.startsWith(`${dir}/`)) return false;
    return /^[A-Za-z0-9][A-Za-z0-9._-]*\/docker\.sock$/.test(path.slice(dir.length + 1));
  });
}

/** @param {string} architecture */
function isArm64(architecture) {
  return architecture === "aarch64" || architecture === "arm64";
}

/**
 * Why the runner must not run on this host, decided before any docker command: it drives Colima only on a Mac, with the
 * checkout under the home directory (the only tree Colima shares), and with `--ci` only in GitHub Actions on a Linux
 * arm64 runner. Never inside the test container, where the suite runs on its own.
 * @param {Pick<RunnerInput, "ci" | "env" | "platform" | "arch" | "homeReal" | "repoReal">} input
 * @returns {string | null}
 */
export function hostRefusal({ ci, env, platform, arch, homeReal, repoReal }) {
  if (env.DESK_IN_CONTAINER === "1") {
    return "the live runner drives the test container from outside; inside the test container the suite runs on its own";
  }
  if (/[,"\n]/.test(repoReal)) {
    return `the checkout's path ${JSON.stringify(repoReal)} holds a character docker's --mount cannot carry`;
  }
  if (ci) {
    if (env.GITHUB_ACTIONS !== "true") {
      return "--ci runs only in GitHub Actions (GITHUB_ACTIONS=true); on the Mac, run it without --ci";
    }
    if (platform !== "linux" || arch !== "arm64") return `--ci runs only on a Linux arm64 runner, not ${platform}-${arch}`;
    return null;
  }
  if (platform !== "darwin") return "without --ci the live runner drives Colima on a Mac; in GitHub Actions, pass --ci";
  if (!repoReal.startsWith(`${homeReal.replace(/\/+$/, "")}/`)) {
    return `the checkout must be under ${homeReal}, the only tree Colima shares with the VM (other paths mount as empty directories)`;
  }
  return null;
}

/**
 * Why the docker engine the runner reached must not be driven, or `null`. On the Mac: the `colima` context, only when it
 * is a Colima profile's socket and the daemon behind it is a running Colima VM on arm64 (the image is linux-arm64); the
 * runner never starts or restarts the VM, which also runs the operator's own containers. In GitHub Actions: the runner's
 * own engine, on linux-arm64.
 * @param {Pick<RunnerInput, "ci" | "env" | "home" | "context" | "info">} input
 * @returns {string | null}
 */
export function engineRefusal({ ci, env, home, context, info }) {
  if (ci) {
    if (info === null) return "the runner's Docker engine is not answering";
    if (info.osType !== "linux" || !isArm64(info.architecture)) {
      return `the runner's Docker engine is ${info.osType}-${info.architecture}; the live image is linux-arm64`;
    }
    return null;
  }
  if (context === null) {
    return "docker has no colima context: install and start Colima yourself (colima start); the runner never starts the VM";
  }
  if (!isColimaSocket(context.endpoint, home, env)) {
    return `the colima docker context points at ${context.endpoint ?? "nothing"}, not at a Colima socket: the runner drives only Colima`;
  }
  if (info === null) {
    return "the Colima VM is not answering: start it yourself (colima start); the runner never starts or restarts the VM";
  }
  if (!/^colima(?:-[A-Za-z0-9._-]+)?$/.test(info.name) || info.osType !== "linux") {
    return `the colima context reaches "${info.name}" (${info.osType}), not a Colima VM`;
  }
  if (!isArm64(info.architecture)) return `the Colima VM is ${info.architecture}; the live image is linux-arm64`;
  return null;
}

/**
 * Why `npm run test:live` must not run here, or `null`: the host's refusal, then the engine's.
 * @param {RunnerInput} input
 * @returns {string | null}
 */
export function runnerRefusal(input) {
  return hostRefusal(input) ?? engineRefusal(input);
}

/**
 * Why the live suite must not start on this GitHub Actions runner, or `null`: while Ubuntu's AppArmor limits
 * unprivileged user namespaces, Chrome cannot start sandboxed in the container. Decided before any docker command, so a
 * workflow that forgot to lift the limit fails in a second with the fix, not after the image build with Chrome's.
 * @param {string | null} value the host's `kernel.apparmor_restrict_unprivileged_userns`, or `null` when the kernel has
 *   no such limit
 * @returns {string | null}
 */
export function userNamespaceRefusal(value) {
  if (value === null || value.trim() === "0") return null;
  return (
    `Chrome's sandbox needs unprivileged user namespaces, and ${USERNS_LIMIT} is ${JSON.stringify(value.trim())}: ` +
    `lift the limit first (sudo sysctl -w ${USERNS_LIMIT}=0, as live-run.yml does); the live suite never runs Chrome ` +
    "with --no-sandbox"
  );
}

/**
 * Why the live suite must not run here, or `null`: it runs only inside the Linux test container, which sets
 * DESK_IN_CONTAINER=1. On the Mac it would start Chrome on the operator's screen.
 * @param {{ platform: string; env: Env }} input
 * @returns {string | null}
 */
export function suiteRefusal({ platform, env }) {
  if (platform !== "linux" || env.DESK_IN_CONTAINER !== "1") {
    return "the live suite runs only inside the Linux test container: run npm run test:live, which starts it";
  }
  return null;
}

/** @param {Container} container @returns {{ host: string; pid: number } | null} the runner that started it */
function runnerOf(container) {
  const runner = /^(.+):(\d+)$/.exec(container.labels[RUNNER_LABEL] ?? "");
  return runner === null || runner[1] === undefined ? null : { host: runner[1], pid: Number(runner[2]) };
}

/** @param {Container} container */
function isDeskContainer(container) {
  return container.name.startsWith(CONTAINER_PREFIX) && container.labels[OWNER_LABEL] === "1" && runnerOf(container) !== null;
}

/** States in which a container holds, or is about to hold, the VM's memory. */
const ACTIVE_STATES = new Set(["created", "restarting", "running", "paused"]);

/**
 * The harness's containers that no live run owns any more, by name, owner label and runner label; nothing else is
 * touched. A container whose runner on this host lives is never one, in any state: between `docker run`'s create and
 * start it is `created`, and `--rm` removes it once it exits. Nor is one docker is already removing. A container of a
 * runner on another host (its pid means nothing here) is one only once it is stopped and older than any phase runs.
 * @param {readonly Container[]} containers
 * @param {{ host: string; alive: (pid: number) => boolean; now: number }} self
 * @returns {Container[]}
 */
export function leftoverContainers(containers, { host, alive, now }) {
  return containers.filter((container) => {
    if (!isDeskContainer(container) || container.state === "removing") return false;
    const runner = runnerOf(container);
    if (runner === null) return false;
    if (runner.host === host) return !alive(runner.pid);
    if (ACTIVE_STATES.has(container.state)) return false;
    const started = Number(container.labels[STARTED_LABEL]);
    return !Number.isFinite(started) || now - started > STALE_AFTER_MS;
  });
}

/**
 * How many Desk containers the VM may run at once: two only when its memory holds two suites at their limit and the
 * headroom, else one. Two 3 GiB suites on a 5.77 GiB VM would leave the VM's OOM killer, not their cgroups, to pick a
 * victim, perhaps one of the operator's containers.
 * @param {number} memTotalBytes `docker info`'s MemTotal
 * @returns {number}
 */
export function deskContainerCap(memTotalBytes) {
  if (!Number.isFinite(memTotalBytes) || memTotalBytes <= 0) return 1;
  const fits = Math.floor((memTotalBytes - VM_HEADROOM_BYTES) / PHASE2_MEMORY_BYTES);
  return Math.max(1, Math.min(MAX_DESK_CONTAINERS, fits));
}

/**
 * Whether the harness may start one more container: fewer of its own are created or running than `cap`.
 * @param {readonly Container[]} containers
 * @param {number} cap
 */
export function canStartDeskContainer(containers, cap) {
  return containers.filter((c) => isDeskContainer(c) && ACTIVE_STATES.has(c.state)).length < cap;
}

/** @param {string | Uint8Array} data */
export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The sha256 over each file's path, NUL, byte length, NUL and bytes, in code-unit order of path, as 16 hex digits.
 * @param {readonly { path: string; bytes: Uint8Array }[]} files
 */
function contentHash(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path).update("\0").update(String(file.bytes.length)).update("\0").update(file.bytes);
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * The files phase 1 installs from, from the root package.json's text: package.json, package-lock.json, .npmrc when
 * there is one, and each workspace's package.json. Workspaces must be plain relative paths.
 * @param {string} manifestText
 * @param {boolean} hasNpmrc
 * @returns {{ ok: true; files: string[]; workspaces: string[] } | { ok: false; reason: string }}
 */
export function installInputs(manifestText, hasNpmrc) {
  /** @type {unknown} */
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return { ok: false, reason: "package.json is not valid JSON" };
  }
  const declared =
    typeof manifest === "object" && manifest !== null && "workspaces" in manifest && Array.isArray(manifest.workspaces)
      ? /** @type {unknown[]} */ (manifest.workspaces)
      : [];
  /** @type {string[]} */
  const workspaces = [];
  for (const workspace of declared) {
    if (
      typeof workspace !== "string" ||
      !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(workspace) ||
      hasDotSegment(workspace)
    ) {
      return {
        ok: false,
        reason: `workspace ${JSON.stringify(workspace)} is not a plain relative path (globs are not supported here)`,
      };
    }
    workspaces.push(workspace);
  }
  const files = [
    "package.json",
    "package-lock.json",
    ...(hasNpmrc ? [".npmrc"] : []),
    ...workspaces.map((workspace) => `${workspace}/package.json`),
  ];
  return { ok: true, files, workspaces };
}

/**
 * The dependency volume for the files npm ci reads (installInputs): linux-arm64 modules live there, never in the Mac's
 * node_modules.
 * @param {readonly { path: string; bytes: Uint8Array }[]} files
 */
export function depsVolumeName(files) {
  return `desk-live-deps-${contentHash(files)}`;
}

/**
 * Whether a file of the image directory (relative to test/live/image, `/`-separated) goes into the image's tag and into
 * the build context the helper streams: never anything under a `node_modules` directory (installing the image's tools
 * locally, test/live/image/tools/node_modules, must not change the tag and force a rebuild, or send a node_modules tree
 * into the build), and never a dotfile or anything under a dot-directory (a Finder .DS_Store must not either; the
 * Dockerfile copies none of them). The tag and the context are the same list of files.
 * @param {string} path
 */
export function imageFileAllowed(path) {
  if (path === "" || path.startsWith("/") || hasDotSegment(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "node_modules" && !segment.startsWith("."));
}

/**
 * The image tag for the image directory's contents: the image is rebuilt only when one of its files changes.
 * @param {readonly { path: string; bytes: Uint8Array }[]} files paths relative to test/live/image
 */
export function imageTag(files) {
  return `desk-live:${contentHash(files)}`;
}

/**
 * The branded Chrome .deb the Dockerfile pins: its name, sha256, and Google's pool URL. A bump changes the two ARG
 * lines together.
 * @param {string} dockerfile
 * @returns {{ deb: string; sha256: string; url: string }}
 */
export function chromePin(dockerfile) {
  const deb = /^ARG CHROME_DEB=(google-chrome-stable_[0-9.]+-[0-9]+_arm64\.deb)$/m.exec(dockerfile)?.[1];
  const sha256 = /^ARG CHROME_SHA256=([0-9a-f]{64})$/m.exec(dockerfile)?.[1];
  if (deb === undefined || sha256 === undefined) {
    throw new Error("test/live/image/Dockerfile must pin CHROME_DEB and CHROME_SHA256");
  }
  return { deb, sha256, url: `https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/${deb}` };
}

/**
 * The pinned .deb's place in a cache, `chrome/<sha256>/<deb>`: in CI under ~/.cache/desk-live/chrome, the directory
 * live-run.yml restores and saves.
 * @param {{ deb: string; sha256: string }} pin
 */
export function chromeCacheFile(pin) {
  return `${CHROME_CACHE_DIR}/${pin.sha256}/${pin.deb}`;
}

/**
 * The name and labels of one container of this run.
 * @param {{ name: string; runner: string; started: number }} input
 * @returns {string[]}
 */
export function containerFlags({ name, runner, started }) {
  return [
    "--name",
    name,
    "--label",
    `${OWNER_LABEL}=1`,
    "--label",
    `${RUNNER_LABEL}=${runner}`,
    "--label",
    `${STARTED_LABEL}=${started}`,
  ];
}

/**
 * One `--mount`. A bind fails when its source is missing, where `--volume` would mount an empty directory.
 * @param {"bind" | "volume"} type
 * @param {string} source
 * @param {string} target
 * @param {boolean} readonly
 * @returns {string[]}
 */
export function mountFlag(type, source, target, readonly) {
  return ["--mount", `type=${type},source=${source},target=${target}${readonly ? ",readonly" : ""}`];
}

/**
 * The cache at `target`: the volume on the Mac, the Actions cache directory in GitHub Actions.
 * @param {CacheStore} cache
 * @param {string} [target]
 * @param {boolean} [readonly]
 * @returns {string[]}
 */
export function cacheMount(cache, target = "/cache", readonly = false) {
  return cache.kind === "volume"
    ? mountFlag("volume", cache.name, target, readonly)
    : mountFlag("bind", cache.path, target, readonly);
}

/**
 * Phase 1 (network on): install.mjs copies the package files from their read-only mounts and runs
 * `npm ci --ignore-scripts` with the dependency volume as node_modules, under a lock in the cache, so two runs never
 * install into one volume at once. Only the package files and phase 1's two scripts are mounted.
 * @param {{ context: EngineContext; name: string; runner: string; started: number; image: string; repo: string;
 *   installFiles: readonly string[]; depsVolume: string; cache: CacheStore }} input
 * @returns {string[]}
 */
export function phase1RunArgs({ context, name, runner, started, image, repo, installFiles, depsVolume, cache }) {
  return [
    ...["--context", context, "run", "--rm", "--interactive", "--pull", "never"],
    ...containerFlags({ name, runner, started }),
    ...["--memory", "2g", "--cpus", "2", "--pids-limit", "2048", "--security-opt", "no-new-privileges"],
    ...[...installFiles, ...PHASE1_SCRIPTS].flatMap((file) => mountFlag("bind", `${repo}/${file}`, `${SRC}/${file}`, true)),
    ...mountFlag("volume", depsVolume, `${WORK}/node_modules`, false),
    ...cacheMount(cache),
    ...["--env", "DESK_IN_CONTAINER=1"],
    image,
    ...["flock", "--exclusive", "--wait", "1200", `/cache/${depsVolume}.lock`],
    ...["node", `${SRC}/test/live/harness/install.mjs`],
  ];
}

/**
 * The checkout's top-level entries that phase 2 mounts, each read-only at `/src/<name>`, as phase 1 mounts only its own
 * files: the files and directories repoPathAllowed lets the container see, so `.git`, `.env` files and everything else
 * at the top of the checkout stay out of the container entirely. Never a symbolic link, which docker would resolve on
 * the host, and never a name that `--mount`'s comma-separated fields could not carry.
 * @param {readonly { name: string; kind: "file" | "dir" | "other" }[]} entries the checkout's top level, as lstat sees it
 * @returns {string[]} names, in code-unit order
 */
export function phase2RepoEntries(entries) {
  const names = entries
    .filter(({ name, kind }) => {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return false;
      if (kind === "file") return repoPathAllowed(name);
      return kind === "dir" && repoPathAllowed(`${name}/file`);
    })
    .map(({ name }) => name);
  return [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Phase 2: the suite, with no network, the lab's limits and seccomp profile (Chrome's sandbox stays on), a pid limit,
 * no new privileges, the repo's allowlisted top-level entries (phase2RepoEntries) read-only, and the dependency volume
 * read-only. `--interactive` keeps the container's stdin open: it is the runner's lifeline, so a container whose runner
 * died ends itself, and `--rm` removes it.
 * @param {{ context: EngineContext; name: string; runner: string; started: number; image: string; repo: string;
 *   repoEntries: readonly string[]; depsVolume: string; run: string; vitestArgs: readonly string[] }} input
 * @returns {string[]}
 */
export function phase2RunArgs({ context, name, runner, started, image, repo, repoEntries, depsVolume, run, vitestArgs }) {
  return [
    ...["--context", context, "run", "--rm", "--interactive", "--pull", "never"],
    ...containerFlags({ name, runner, started }),
    ...["--network", "none", "--shm-size", "1g", "--memory", "3g", "--cpus", "3", "--pids-limit", "2048"],
    ...["--security-opt", `seccomp=${repo}/test/live/chrome-seccomp.json`],
    ...["--security-opt", "no-new-privileges"],
    ...repoEntries.flatMap((entry) => mountFlag("bind", `${repo}/${entry}`, `${SRC}/${entry}`, true)),
    ...mountFlag("volume", depsVolume, `${WORK}/node_modules`, true),
    ...["--env", "DESK_IN_CONTAINER=1"],
    ...["--env", `DESK_LIVE_RUN=${run}`],
    ...["--env", `DESK_LIVE_IMAGE=${image}`],
    ...["--env", `DESK_LIVE_DEPS=${depsVolume}`],
    ...[image, "node", `${SRC}/test/live/harness/run.mjs`, ...vitestArgs],
  ];
}

/**
 * The line run.mjs prints when the suite is over, before it waits for stdin to close.
 * @param {string} run
 * @param {number} code
 */
export function doneLine(run, code) {
  return `${DONE_MARKER} ${run} ${code}`;
}

/**
 * The suite's exit code when `line` is this run's done line, else `null`. The run id is random per run and never in
 * vitest's environment, so a line a test prints cannot pass for it.
 * @param {string} line
 * @param {string} run
 * @returns {number | null}
 */
export function doneCode(line, run) {
  const match = /^::desk-live-done:: ([0-9a-f]{8}) (\d{1,3})\s*$/.exec(line);
  return match !== null && match[1] === run ? Number(match[2]) : null;
}

/**
 * Milliseconds since the epoch from docker's `CreatedAt` (`2026-10-06 17:27:01 -0500 CDT` in listings, RFC 3339 in
 * inspect output), or `null`.
 * @param {string} text
 * @returns {number | null}
 */
export function dockerTime(text) {
  const listing = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})(?:\s|$)/.exec(text);
  const ms = listing ? Date.parse(`${listing[1]}T${listing[2]}${listing[3]}:${listing[4]}`) : Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/** @param {Readonly<Record<string, string>>} labels */
function harnessLabelled(labels) {
  return labels[RESOURCE_LABEL] === "1" || labels[OWNER_LABEL] === "1";
}

/**
 * The harness images to remove after a build: `desk-live` and `desk-live-fetch` images with a content tag and a harness
 * label, except the current tag and the newest other one (another checkout, such as a worktree, may still use it).
 * Never another repository's image.
 * @param {readonly { repository: string; tag: string; createdAt: number; labels: Readonly<Record<string, string>> }[]} images
 * @param {string} current `desk-live:<tag>`
 * @returns {string[]} `repository:tag` references
 */
export function imagesToPrune(images, current) {
  const ours = images.filter(
    (image) =>
      (image.repository === "desk-live" || image.repository === "desk-live-fetch") &&
      /^[0-9a-f]{16}$/.test(image.tag) &&
      harnessLabelled(image.labels),
  );
  const currentTag = current.slice("desk-live:".length);
  const newestOther = ours
    .filter((image) => image.repository === "desk-live" && image.tag !== currentTag)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  const keep = new Set([currentTag, ...(newestOther === undefined ? [] : [newestOther.tag])]);
  return ours.filter((image) => !keep.has(image.tag)).map((image) => `${image.repository}:${image.tag}`);
}

/**
 * The dependency volumes to remove after a new one is installed: harness-labelled `desk-live-deps-<hash>` volumes except
 * the current one and the newest other one. Never the cache volume, which holds the Chrome .deb Google may have pruned.
 * @param {readonly { name: string; createdAt: number; labels: Readonly<Record<string, string>> }[]} volumes
 * @param {string} current
 * @returns {string[]}
 */
export function volumesToPrune(volumes, current) {
  return volumes
    .filter(
      (volume) =>
        /^desk-live-deps-[0-9a-f]{16}$/.test(volume.name) && harnessLabelled(volume.labels) && volume.name !== current,
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(1)
    .map((volume) => volume.name);
}

/** Top-level files the container sees. */
const ALLOWED_FILES = [/^package\.json$/, /^package-lock\.json$/, /^\.npmrc$/, /^tsconfig[^/]*\.json$/, /^vitest[^/]*\.config\.ts$/];

/** Top-level directories the container sees. */
const ALLOWED_DIRS = ["packages", "test", "scripts"];

/** Never copied from anywhere: dependencies built for the Mac, state, results, environment files. */
const EXCLUDED_SEGMENTS = ["node_modules", ".desk", ".agent-browser", "test-results", ".git"];

/**
 * Whether the container copies this repo path (relative, `/`-separated) from the read-only mount: the package files,
 * the TypeScript and Vitest configs, and packages/, test/ and scripts/, never node_modules (the Mac's are darwin
 * builds), Desk or agent-browser state, results, or `.env` files.
 * @param {string} path
 */
export function repoPathAllowed(path) {
  if (path === "" || path.startsWith("/") || hasDotSegment(path)) return false;
  const segments = path.split("/");
  if (segments.some((segment) => EXCLUDED_SEGMENTS.includes(segment) || segment.startsWith(".env"))) return false;
  const [top] = segments;
  if (top === undefined) return false;
  if (segments.length === 1) return ALLOWED_FILES.some((pattern) => pattern.test(top));
  return ALLOWED_DIRS.includes(top);
}

/** The repo's `.dockerignore`: the same allowlist, for any build context taken from the repo root. */
export function dockerignoreText() {
  return [
    "# An allowlist (docs/IMPLEMENTATION.md §17.3, §18), generated from scripts/lib/live.mjs and checked by",
    "# test/live-runner.test.ts: a build context taken from the repo root sends only these, never .env files, .git,",
    "# node_modules (the Mac's are darwin builds), Desk or agent-browser state, or test results.",
    "*",
    "!package.json",
    "!package-lock.json",
    "!.npmrc",
    "!tsconfig*.json",
    "!vitest*.config.ts",
    ...ALLOWED_DIRS.map((dir) => `!${dir}/**`),
    ...EXCLUDED_SEGMENTS.map((segment) => `**/${segment}`),
    "**/.env*",
    "",
  ].join("\n");
}
