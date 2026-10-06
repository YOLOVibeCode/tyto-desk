/**
 * The live harness's decisions (docs/IMPLEMENTATION.md §17.3), kept pure so `npm test` checks them offline:
 * where the runner and the suite may run, which containers are leftovers, how many Desk containers may run at once,
 * how volumes and images are named, the docker argv of both phases, and which repo files the container sees.
 * scripts/live.mjs (the Mac side) and test/live/harness/*.mjs (the container side) use them. Node builtins only:
 * phase 1 imports this before any dependency is installed.
 */
import { createHash } from "node:crypto";

/** The only docker context the runner drives. */
export const LIVE_CONTEXT = "colima";

/**
 * Every container the harness starts is named `desk-live-<role>-<run>` and carries both container labels. Images and
 * volumes carry only RESOURCE_LABEL: an image's labels reach every container made from it, so a container is the
 * harness's only by its name, the owner label and a runner label, which only the runner sets.
 */
export const CONTAINER_PREFIX = "desk-live-";
export const OWNER_LABEL = "com.noctusoft.desk-live";
export const RUNNER_LABEL = "com.noctusoft.desk-live.runner";
export const RESOURCE_LABEL = "com.noctusoft.desk-live.resource";

/** The VM also runs the operator's own containers. */
export const MAX_DESK_CONTAINERS = 2;

/** The Chrome .deb (by sha256) and npm's cache. Google prunes old builds from its pool, so the .deb is kept here. */
export const CACHE_VOLUME = "desk-live-cache";

/** Where the container sees the repo (read-only) and where the suite runs from. */
export const SRC = "/src";
export const WORK = "/work";

/** @typedef {{ name: string; endpoint: string | null }} DockerContext */
/** @typedef {{ name: string; osType: string; architecture: string }} DockerInfo */
/** @typedef {Readonly<Record<string, string | undefined>>} Env */
/**
 * @typedef {{ env: Env; home: string; context: DockerContext | null; info: DockerInfo | null }} RunnerInput
 */
/** @typedef {{ id: string; name: string; state: string; labels: Readonly<Record<string, string>> }} Container */

/** @param {string} path */
function hasDotSegment(path) {
  return path.split("/").some((segment) => segment === "." || segment === "..");
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

/**
 * Why `npm run test:live` must not run here, or `null`. It drives only the `colima` docker context, and only when that
 * context is a Colima profile's socket and the daemon behind it is a running Colima VM on arm64 (the image is
 * linux-arm64). It never starts or restarts the VM, which also runs the operator's own containers.
 * @param {RunnerInput} input
 * @returns {string | null}
 */
export function runnerRefusal({ env, home, context, info }) {
  if (env.DESK_IN_CONTAINER === "1") {
    return "the live runner drives the Colima VM from the Mac; inside the test container the suite runs on its own";
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
  if (info.architecture !== "aarch64" && info.architecture !== "arm64") {
    return `the Colima VM is ${info.architecture}; the live image is linux-arm64`;
  }
  return null;
}

/**
 * Why the live suite must not run here, or `null`: it runs only inside the Linux test container, which sets
 * DESK_IN_CONTAINER=1. On the Mac it would start Chrome on the operator's screen.
 * @param {{ platform: string; env: Env }} input
 * @returns {string | null}
 */
export function suiteRefusal({ platform, env }) {
  if (platform !== "linux" || env.DESK_IN_CONTAINER !== "1") {
    return "the live suite runs only inside the Linux test container: run npm run test:live, which drives the Colima VM";
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

/**
 * The harness's containers that no live run owns any more: stopped ones, and running ones whose runner on this host is
 * gone. A container is the harness's only by its name, its owner label and its runner label; nothing else is touched.
 * @param {readonly Container[]} containers
 * @param {{ host: string; alive: (pid: number) => boolean }} self
 * @returns {Container[]}
 */
export function leftoverContainers(containers, { host, alive }) {
  return containers.filter((container) => {
    if (!isDeskContainer(container)) return false;
    if (container.state !== "running") return true;
    const runner = runnerOf(container);
    return runner !== null && runner.host === host && !alive(runner.pid);
  });
}

/**
 * Whether the harness may start one more container: fewer than two of its own are running.
 * @param {readonly Container[]} containers
 */
export function canStartDeskContainer(containers) {
  return containers.filter((c) => isDeskContainer(c) && c.state === "running").length < MAX_DESK_CONTAINERS;
}

/** @param {string | Uint8Array} data */
export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The dependency volume for this package-lock.json: linux-arm64 modules live there, never in the Mac's node_modules.
 * @param {string} lockText
 */
export function depsVolumeName(lockText) {
  return `desk-live-deps-${sha256Hex(lockText).slice(0, 16)}`;
}

/**
 * The image tag for the image directory's contents: the image is rebuilt only when one of its files changes. Paths are
 * sorted by code unit, so every machine computes the same tag.
 * @param {readonly { path: string; bytes: Uint8Array }[]} files paths relative to test/live/image
 */
export function imageTag(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path).update("\0").update(String(file.bytes.length)).update("\0").update(file.bytes);
  }
  return `desk-live:${hash.digest("hex").slice(0, 16)}`;
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

/** @param {{ name: string; runner: string }} input */
function containerFlags({ name, runner }) {
  return ["--name", name, "--label", `${OWNER_LABEL}=1`, "--label", `${RUNNER_LABEL}=${runner}`];
}

/**
 * Phase 1 (network on): copy the package files from the read-only repo and run `npm ci --ignore-scripts` with the
 * dependency volume as node_modules.
 * @param {{ name: string; runner: string; image: string; repo: string; depsVolume: string }} input
 * @returns {string[]}
 */
export function phase1RunArgs({ name, runner, image, repo, depsVolume }) {
  return [
    "--context",
    LIVE_CONTEXT,
    "run",
    "--rm",
    "--interactive",
    ...containerFlags({ name, runner }),
    "--memory",
    "2g",
    "--cpus",
    "2",
    "--volume",
    `${repo}:${SRC}:ro`,
    "--volume",
    `${depsVolume}:${WORK}/node_modules`,
    "--volume",
    `${CACHE_VOLUME}:/cache`,
    "--env",
    "DESK_IN_CONTAINER=1",
    image,
    "node",
    `${SRC}/test/live/harness/install.mjs`,
  ];
}

/**
 * Phase 2: the suite, with no network, the lab's limits and seccomp profile (Chrome's sandbox stays on), the repo
 * read-only and the dependency volume read-only. `--interactive` keeps the container's stdin open: it is the runner's
 * lifeline, so a container whose runner died ends itself, and `--rm` removes it.
 * @param {{ name: string; runner: string; image: string; repo: string; depsVolume: string; vitestArgs: readonly string[] }} input
 * @returns {string[]}
 */
export function phase2RunArgs({ name, runner, image, repo, depsVolume, vitestArgs }) {
  return [
    "--context",
    LIVE_CONTEXT,
    "run",
    "--rm",
    "--interactive",
    ...containerFlags({ name, runner }),
    "--network",
    "none",
    "--shm-size",
    "1g",
    "--memory",
    "3g",
    "--cpus",
    "3",
    "--security-opt",
    `seccomp=${repo}/test/live/chrome-seccomp.json`,
    "--volume",
    `${repo}:${SRC}:ro`,
    "--volume",
    `${depsVolume}:${WORK}/node_modules:ro`,
    "--env",
    "DESK_IN_CONTAINER=1",
    "--env",
    `DESK_LIVE_IMAGE=${image}`,
    "--env",
    `DESK_LIVE_DEPS=${depsVolume}`,
    image,
    "node",
    `${SRC}/test/live/harness/run.mjs`,
    ...vitestArgs,
  ];
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
