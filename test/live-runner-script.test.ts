import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { anotherRunners, ci, colimaVm, exists, harness, modes, onTheMac, subcommand, withoutContext } from "./fixtures/live-runner-harness.ts";

describe("the live runner script, driving a stub docker: guards, results and other runners' containers", () => {
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
});
