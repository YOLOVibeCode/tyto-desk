// @ts-check
/**
 * A stand-in for the docker CLI in the live runner's offline tests (docs/IMPLEMENTATION.md §17.1, the stub-executable
 * level). It never reaches a Docker engine. The test writes a wrapper that runs it as
 * `node stub-docker.mjs <scenario.json> <calls.log> <docker argv…>`; it appends the argv to the log as one JSON line and
 * answers the way the scenario says, playing the harness's containers by the command each one runs:
 *
 *   context inspect, info     the docker context's endpoint and the engine's facts (null: the command fails)
 *   ps, image ls, volume ls   nothing listed
 *   image inspect             exit 0 when `imageCached`
 *   volume inspect            exit 0 when `volumesExist`
 *   run … test -f             the dependency volume's readiness check: exit 0 when `depsReady`, or `depsCheckExit`
 *   run … build-context       a few bytes of build context on stdout
 *   run … run.mjs             phase 2: `phase2.stdout` lines (`<run>` becomes DESK_LIVE_RUN), `phase2.stderr`; with
 *                             `phase2.untilKilled`, "suite running" and then nothing until `kill` was called (and,
 *                             with `phase2.ignoreKill`, nothing after it either, until it is killed); then, when
 *                             `phase2.done` is a number, the done line, after which it waits for stdin to close; then
 *                             it exits with `phase2.exit`
 *   kill                      records that it was called
 *   build                     reads its stdin to the end
 *   cp                        copies `results` into the destination (plus `resultsSymlink`, a link it adds), or exits
 *                             with `cpExit`
 *   anything else             exit 0
 */
import { access, appendFile, cp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [scenarioPath = "", logPath = "", ...argv] = process.argv.slice(2);
/**
 * @type {{
 *   context: string | null;
 *   info: Record<string, unknown> | null;
 *   imageCached?: boolean;
 *   volumesExist?: boolean;
 *   depsReady?: boolean;
 *   depsCheckExit?: number;
 *   phase1Exit?: number;
 *   phase2?: { stdout?: string[]; stderr?: string; untilKilled?: boolean; ignoreKill?: boolean; done?: number | null; exit: number };
 *   results?: string;
 *   resultsSymlink?: { name: string; target: string };
 *   cpExit?: number;
 * }}
 */
const scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
await appendFile(logPath, `${JSON.stringify(argv)}\n`);

const args = argv[0] === "--context" ? argv.slice(2) : argv;
const [command, sub] = args;

/** @param {number} code @returns {never} */
function exit(code) {
  process.exit(code);
}

/** @returns {Promise<void>} */
function stdinClosed() {
  return new Promise((resolve) => {
    process.stdin.on("end", resolve);
    process.stdin.on("error", () => resolve());
    process.stdin.resume();
  });
}

switch (command) {
  case "context":
    if (scenario.context === null) {
      process.stderr.write('context "colima": context not found\n');
      exit(1);
    }
    process.stdout.write(JSON.stringify([{ Name: "colima", Endpoints: { docker: { Host: scenario.context } } }]));
    exit(0);
  case "info":
    if (scenario.info === null) {
      process.stderr.write("Cannot connect to the Docker daemon\n");
      exit(1);
    }
    process.stdout.write(JSON.stringify(scenario.info));
    exit(0);
  case "image":
    exit(sub === "inspect" && !scenario.imageCached ? 1 : 0);
  case "volume":
    if (sub === "inspect") exit(scenario.volumesExist ? 0 : 1);
    exit(0);
  case "build":
    await stdinClosed();
    exit(0);
  case "kill":
    await writeFile(`${logPath}.killed`, "");
    exit(0);
  case "cp": {
    if (scenario.cpExit !== undefined && scenario.cpExit !== 0) {
      process.stderr.write("Error response from daemon: Could not find the file /home/lab/results in container\n");
      exit(scenario.cpExit);
    }
    const destination = args[2] ?? "";
    if (scenario.results !== undefined) await cp(scenario.results, destination, { recursive: true });
    if (scenario.resultsSymlink !== undefined) {
      await symlink(scenario.resultsSymlink.target, join(destination, scenario.resultsSymlink.name));
    }
    exit(0);
  }
  case "run": {
    if (args.includes("test")) exit(scenario.depsCheckExit ?? (scenario.depsReady ? 0 : 1));
    if (args.includes("build-context")) {
      process.stdout.write("context bytes");
      exit(0);
    }
    if (args.some((arg) => arg.endsWith("/install.mjs"))) exit(scenario.phase1Exit ?? 0);
    if (args.some((arg) => arg.endsWith("/run.mjs"))) {
      const phase2 = scenario.phase2 ?? { done: 0, exit: 0 };
      const run = args.find((arg) => arg.startsWith("DESK_LIVE_RUN="))?.slice("DESK_LIVE_RUN=".length) ?? "";
      for (const line of phase2.stdout ?? []) process.stdout.write(`${line.replaceAll("<run>", run)}\n`);
      if (phase2.stderr !== undefined) process.stderr.write(`${phase2.stderr}\n`);
      if (phase2.untilKilled === true) {
        process.stdout.write("suite running\n");
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && !(await access(`${logPath}.killed`).then(() => true, () => false))) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        // A suite that never stops: the process lives until it is killed.
        if (phase2.ignoreKill === true) await new Promise(() => setInterval(() => undefined, 1_000));
      }
      if (typeof phase2.done === "number") {
        process.stdout.write(`\n::desk-live-done:: ${run} ${phase2.done}\n`);
        await stdinClosed();
      }
      exit(phase2.exit);
    }
    exit(0);
  }
  default:
    exit(0);
}
