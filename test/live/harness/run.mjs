// @ts-check
/**
 * Phase 2 of the live harness, inside the container (docs/IMPLEMENTATION.md §17.3). The runner starts it with no
 * network, the repo read-only at /src, and the dependency volume read-only at /work/node_modules. It refuses to run
 * anywhere but the Linux test container, copies the allowlisted repo files into /work, starts Xvfb :99 at 1440×900×24
 * with its framebuffer in a file the tests read, records the versions it runs against, and runs the live suite
 * (vitest.live.config.ts) into /home/lab/results.
 *
 * Whatever happens after the guard, it then writes environment.json (with the failure, if one stopped it), prints
 * `::desk-live-done:: <run> <exit code>` and waits for stdin to close: the runner copies the results out with docker cp
 * first, and `--rm` removes the container after it exits. stdin closing early (the runner died), SIGTERM (the runner's
 * timeout or Ctrl+C, through tini) or SIGINT stops the suite; the run id comes only from the runner, never from vitest's
 * environment.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { release } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { FRAMEBUFFER_DIR, RESULTS, SRC, WORK, doneLine, repoPathAllowed, suiteRefusal } from "../../../scripts/lib/live.mjs";

const execFileP = promisify(execFile);
const DISPLAY = ":99";
const SCREEN = "1440x900x24";
/** The environment of the helper processes run.mjs starts itself (Xvfb, version probes); vitest's is below. */
const TOOL_ENV = { HOME: "/home/lab", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TZ: "UTC" };

const refusal = suiteRefusal({ platform: process.platform, env: process.env });
if (refusal !== null) {
  console.error(`phase 2: ${refusal}`);
  process.exit(1);
}

const run = /^[0-9a-f]{8}$/.test(process.env.DESK_LIVE_RUN ?? "") ? String(process.env.DESK_LIVE_RUN) : "unknown";
const startedAt = new Date();

let stdinClosed = false;
/** @type {Array<() => void>} */
const onStdinClosed = [];
let stopRequested = false;
/** @type {(() => void) | null} */
let stopSuite = null;
/** Stops the suite now, or keeps it from starting: the runner went away, timed out, or was interrupted. */
const requestStop = () => {
  stopRequested = true;
  stopSuite?.();
};
process.stdin.on("end", () => {
  stdinClosed = true;
  requestStop();
  for (const listener of onStdinClosed.splice(0)) listener();
});
process.stdin.resume();
process.on("SIGINT", requestStop);
process.on("SIGTERM", requestStop);

/** @param {string} when */
function unlessStopped(when) {
  if (stopRequested) throw new Error(`stopped ${when}: the runner went away, timed out, or was interrupted`);
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
 * Copies what the container may see of the repo. Directories pass when a file inside them could, so node_modules,
 * state and results are never even entered.
 */
async function copyRepo() {
  if (!(await isFile(join(SRC, "package.json")))) {
    throw new Error("the repo is not visible at /src: on the Mac, Colima shares only your home directory");
  }
  await cp(SRC, WORK, {
    recursive: true,
    filter: async (source) => {
      const rel = relative(SRC, source);
      if (rel === "") return true;
      return (await lstat(source)).isDirectory() ? repoPathAllowed(`${rel}/file`) : repoPathAllowed(rel);
    },
  });
}

/** Starts Xvfb and waits for its socket: a private framebuffer, mirrored to a file, and no TCP listener. */
async function startXvfb() {
  await mkdir(FRAMEBUFFER_DIR, { recursive: true });
  const log = await open(join(RESULTS, "xvfb.log"), "a");
  const xvfb = spawn("Xvfb", [DISPLAY, "-screen", "0", SCREEN, "-fbdir", FRAMEBUFFER_DIR, "-nolisten", "tcp", "-ac"], {
    env: TOOL_ENV,
    stdio: ["ignore", log.fd, log.fd],
  });
  await log.close();
  const socket = `/tmp/.X11-unix/X${DISPLAY.slice(1)}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await stat(socket).then(() => true, () => false)) return xvfb;
    if (xvfb.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  xvfb.kill("SIGTERM");
  throw new Error(`Xvfb did not start on ${DISPLAY} (see xvfb.log)`);
}

/** @param {string} file @param {string[]} args */
async function versionOf(file, args) {
  try {
    const { stdout } = await execFileP(file, args, { env: TOOL_ENV, signal: AbortSignal.timeout(20_000) });
    return stdout.trim().split("\n")[0] ?? "";
  } catch (err) {
    return `unavailable (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`;
  }
}

/** @param {string} path */
async function packageVersion(path) {
  try {
    return String(JSON.parse(await readFile(join(path, "package.json"), "utf8")).version);
  } catch (err) {
    return `unavailable (${/** @type {{ code?: string }} */ (err).code ?? "unknown"})`;
  }
}

/** The node-pty package the repo depends on, its platform package, and the sha256 of the native module it loads. */
async function ptyPackage() {
  const manifest = JSON.parse(await readFile(join(WORK, "package.json"), "utf8"));
  const name = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).find((n) => /(^|\/)node-pty$/.test(n));
  if (name === undefined) return { name: "none" };
  const platformName = name.startsWith("@lydell/") ? `${name}-${process.platform}-${process.arch}` : name;
  const native = join(WORK, "node_modules", platformName, "prebuilds", `${process.platform}-${process.arch}`, "pty.node");
  const sha256 = await readFile(native).then(
    (bytes) => createHash("sha256").update(bytes).digest("hex"),
    () => "unavailable",
  );
  return {
    name,
    version: await packageVersion(join(WORK, "node_modules", name)),
    platformPackage: platformName,
    platformVersion: await packageVersion(join(WORK, "node_modules", platformName)),
    nativeModuleSha256: sha256,
  };
}

/** The versions the suite runs against. */
async function versions() {
  const tools = "/opt/desk-live/tools/node_modules";
  return {
    chrome: await versionOf("/usr/bin/google-chrome-stable", ["--version"]),
    node: process.version,
    agentBrowser: await versionOf("agent-browser", ["--version"]),
    pty: await ptyPackage(),
    tmux: await versionOf("tmux", ["-V"]),
    zsh: await versionOf("zsh", ["--version"]),
    puppeteerCore: await packageVersion(join(tools, "puppeteer-core")),
    playwrightCore: await packageVersion(join(tools, "playwright-core")),
  };
}

/** A cgroup v2 counter of this container (memory.peak, pids.peak), to size the limits from data. @param {string} name */
async function cgroupPeak(name) {
  try {
    const text = (await readFile(`/sys/fs/cgroup/${name}`, "utf8")).trim();
    return /^\d+$/.test(text) ? Number(text) : text;
  } catch {
    return "unavailable";
  }
}

/**
 * Runs the live suite. `--configLoader native`: Node imports the config itself (stripping its types). Vite's default
 * loader writes a bundled copy into node_modules/.vite-temp, and node_modules is the read-only dependency volume.
 * @param {readonly string[]} args
 * @returns {Promise<number>}
 */
function runVitest(args) {
  return new Promise((resolve) => {
    const vitest = spawn(
      process.execPath,
      [
        join(WORK, "node_modules", "vitest", "vitest.mjs"),
        "run",
        "--config",
        join(WORK, "vitest.live.config.ts"),
        "--configLoader",
        "native",
        ...args,
      ],
      {
        cwd: WORK,
        stdio: ["ignore", "inherit", "inherit"],
        env: {
          HOME: "/home/lab",
          USER: "lab",
          LOGNAME: "lab",
          PATH: "/usr/local/bin:/usr/bin:/bin",
          LANG: "C.UTF-8",
          TZ: "UTC",
          TMPDIR: "/tmp",
          DISPLAY,
          DESK_IN_CONTAINER: "1",
          DESK_LIVE_RESULTS: RESULTS,
        },
      },
    );
    stopSuite = () => {
      if (vitest.exitCode !== null || vitest.signalCode !== null) return;
      vitest.kill("SIGTERM");
      setTimeout(() => vitest.kill("SIGKILL"), 10_000).unref();
    };
    if (stopRequested) stopSuite();
    vitest.once("error", () => resolve(1));
    vitest.once("close", (status) => resolve(status ?? 1));
  });
}

/** @type {Record<string, unknown>} */
let environment = {
  run,
  image: process.env.DESK_LIVE_IMAGE ?? "unknown",
  dependencies: process.env.DESK_LIVE_DEPS ?? "unknown",
  kernel: release(),
  arch: process.arch,
  display: `${DISPLAY} ${SCREEN}`,
};
let code = 1;
/** @type {string | null} */
let failure = null;
/** @type {import("node:child_process").ChildProcess | null} */
let xvfb = null;
try {
  await mkdir(RESULTS, { recursive: true });
  await copyRepo();
  unlessStopped("before Xvfb started");
  xvfb = await startXvfb();
  environment = { ...environment, ...(await versions()) };
  unlessStopped("before the suite started");
  code = await runVitest(process.argv.slice(2));
} catch (err) {
  failure = err instanceof Error ? err.message : String(err);
  console.error(`phase 2: ${failure}`);
  code = 1;
}

const finishedAt = new Date();
try {
  await mkdir(RESULTS, { recursive: true });
  const record = {
    ...environment,
    memoryPeakBytes: await cgroupPeak("memory.peak"),
    pidsPeak: await cgroupPeak("pids.peak"),
    startedAt,
    finishedAt,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    exitCode: code,
    ...(failure === null ? {} : { failure }),
  };
  await writeFile(join(RESULTS, "environment.json"), `${JSON.stringify(record, null, 2)}\n`);
} catch (err) {
  console.error(`phase 2: writing environment.json failed: ${err instanceof Error ? err.message : String(err)}`);
}
xvfb?.kill("SIGTERM");

if (!stdinClosed) {
  process.stdout.write(`\n${doneLine(run, code)}\n`);
  await new Promise((resolve) => onStdinClosed.push(() => resolve(undefined)));
}
process.exit(code);
