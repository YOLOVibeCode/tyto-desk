// @ts-check
/**
 * Phase 2 of the live harness, inside the container (docs/IMPLEMENTATION.md §17.3). scripts/live.mjs starts it with no
 * network, the repo read-only at /src, and the dependency volume read-only at /work/node_modules. It refuses to run
 * anywhere but the Linux test container, copies the allowlisted repo files into /work, starts Xvfb :99 at 1440×900×24,
 * records the versions it runs against, and runs the live suite (vitest.live.config.ts) into /home/lab/results.
 * Then it prints `::desk-live-done:: <exit code>` and waits for stdin to close: the runner copies the results out with
 * docker cp first, and `--rm` removes the container after it exits. stdin closing early (the runner died) stops the
 * suite.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { release } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { SRC, WORK, repoPathAllowed, suiteRefusal } from "../../../scripts/lib/live.mjs";

const execFileP = promisify(execFile);
const RESULTS = "/home/lab/results";
const DISPLAY = ":99";
const SCREEN = "1440x900x24";
const DONE = "::desk-live-done::";
/** The environment of the helper processes run.mjs starts itself (Xvfb, version probes); vitest's is below. */
const TOOL_ENV = { HOME: "/home/lab", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TZ: "UTC" };

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`phase 2: ${message}`);
  process.exit(1);
}

const refusal = suiteRefusal({ platform: process.platform, env: process.env });
if (refusal !== null) fail(refusal);

const startedAt = new Date();
let stdinClosed = false;
/** @type {Array<() => void>} */
const onStdinClosed = [];
process.stdin.on("end", () => {
  stdinClosed = true;
  for (const listener of onStdinClosed.splice(0)) listener();
});
process.stdin.resume();

/**
 * Copies what the container may see of the repo. Directories pass when a file inside them could, so node_modules,
 * state and results are never even entered.
 */
await cp(SRC, WORK, {
  recursive: true,
  filter: async (source) => {
    const rel = relative(SRC, source);
    if (rel === "") return true;
    return (await lstat(source)).isDirectory() ? repoPathAllowed(`${rel}/file`) : repoPathAllowed(rel);
  },
});
await mkdir(RESULTS, { recursive: true });

/** Starts Xvfb and waits for its socket: a private framebuffer, no TCP listener. */
async function startXvfb() {
  const log = await open(join(RESULTS, "xvfb.log"), "a");
  const xvfb = spawn("Xvfb", [DISPLAY, "-screen", "0", SCREEN, "-nolisten", "tcp", "-ac"], {
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
  return fail(`Xvfb did not start on ${DISPLAY} (see xvfb.log)`);
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

const xvfb = await startXvfb();
const tools = "/opt/desk-live/tools/node_modules";
const environment = {
  image: process.env.DESK_LIVE_IMAGE ?? "unknown",
  dependencies: process.env.DESK_LIVE_DEPS ?? "unknown",
  kernel: release(),
  arch: process.arch,
  display: `${DISPLAY} ${SCREEN}`,
  chrome: await versionOf("/usr/bin/google-chrome-stable", ["--version"]),
  node: process.version,
  agentBrowser: await versionOf("agent-browser", ["--version"]),
  pty: await ptyPackage(),
  tmux: await versionOf("tmux", ["-V"]),
  zsh: await versionOf("zsh", ["--version"]),
  puppeteerCore: await packageVersion(join(tools, "puppeteer-core")),
  playwrightCore: await packageVersion(join(tools, "playwright-core")),
};

// `--configLoader native`: Node imports the config itself (stripping its types). Vite's default loader writes a bundled
// copy into node_modules/.vite-temp, and node_modules is the read-only dependency volume.
const vitest = spawn(
  process.execPath,
  [
    join(WORK, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "--config",
    join(WORK, "vitest.live.config.ts"),
    "--configLoader",
    "native",
    ...process.argv.slice(2),
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
/** Stops the suite: the runner went away, or Ctrl+C reached the container. */
const stopSuite = () => {
  if (vitest.exitCode !== null) return;
  vitest.kill("SIGTERM");
  setTimeout(() => vitest.kill("SIGKILL"), 10_000).unref();
};
onStdinClosed.push(stopSuite);
process.once("SIGINT", stopSuite);
process.once("SIGTERM", stopSuite);
const code = await new Promise((resolve) => {
  vitest.once("error", () => resolve(1));
  vitest.once("close", (status) => resolve(status ?? 1));
});

const finishedAt = new Date();
await writeFile(
  join(RESULTS, "environment.json"),
  `${JSON.stringify({ ...environment, startedAt, finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(), exitCode: code }, null, 2)}\n`,
);
xvfb.kill("SIGTERM");

if (!stdinClosed) {
  process.stdout.write(`\n${DONE} ${code}\n`);
  await new Promise((resolve) => onStdinClosed.push(() => resolve(undefined)));
}
process.exit(Number(code));
