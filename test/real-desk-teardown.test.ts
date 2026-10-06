import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("..", import.meta.url));
const vitestCli = join(repo, "node_modules", "vitest", "vitest.mjs");
const globalSetup = join(repo, "test", "setup", "global-setup.ts");

/**
 * Runs a one-test suite under this repo's real global setup in a child Vitest, with HOME set to a stand-in home, so
 * "the real ~/.desk" of that run is a directory this test made. The fixture writes `entry` there behind the adapter
 * guard's back, as a buggy adapter would, and refuses to write anywhere but the stand-in.
 */
async function suiteWritingIntoRealDesk(entry: string): Promise<{ code: number; output: string }> {
  const base = await mkdtemp(join(tmpdir(), "teardown-"));
  const standInHome = join(base, "home");
  const project = join(base, "project");
  await mkdir(join(standInHome, ".desk", "logs"), { recursive: true });
  await writeFile(join(standInHome, ".desk", "config.json"), "{}");
  await writeFile(join(standInHome, ".desk", "logs", "ptyd.log"), "a");
  await mkdir(project);
  await mkdir(join(base, "tmp"));
  await writeFile(
    join(project, "vitest.config.mjs"),
    `export default { test: { include: ["*.test.mjs"], globals: true, globalSetup: [${JSON.stringify(globalSetup)}] } };\n`,
  );
  await writeFile(
    join(project, "writes-real-desk.test.mjs"),
    [
      'import { appendFile } from "node:fs/promises";',
      'import { join } from "node:path";',
      'it("writes into the real ~/.desk", async () => {',
      "  const realHome = process.env.DESK_TEST_REAL_HOME;",
      '  if (!realHome || realHome !== process.env.DESK_FIXTURE_STAND_IN) throw new Error("not the stand-in home");',
      `  await appendFile(join(realHome, ".desk", ${JSON.stringify(entry)}), "b");`,
      "});",
      "",
    ].join("\n"),
  );
  const env = { PATH: process.env.PATH ?? "", HOME: standInHome, TMPDIR: join(base, "tmp"), DESK_FIXTURE_STAND_IN: standInHome };
  try {
    await run(process.execPath, [vitestCli, "run", "--root", project, "--config", join(project, "vitest.config.mjs")], {
      cwd: project,
      env,
    });
    return { code: 0, output: "" };
  } catch (err) {
    const failure = err as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

describe("the real ~/.desk check after the suite", () => {
  it.each([
    ["panes.json", "a file a running Desk rewrites"],
    ["logs/ptyd.log", "a log a running Desk appends to"],
  ])("the global teardown fails the run when a test wrote %s (%s) into the real ~/.desk", async (entry) => {
    const result = await suiteWritingIntoRealDesk(entry);

    expect([result.code, result.output]).toEqual([1, expect.stringContaining("The real ~/.desk changed")]);
  }, 60_000);
});
