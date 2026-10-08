import { describe, expect, it } from "vitest";
import { DESK_COMPAT, listVersions, parseInstalled, retainVersions, rollbackVersion, useVersion } from "../src/index.ts";
import { FakeClock, FakeInstanceLock, FakeProcessInfo, MemoryAppVersions, MemoryTextFiles, ScriptedPrompter } from "../src/testing/index.ts";

const deskHome = "/Users/alex/.desk";
const versionJson = (version: string, state: Record<string, number> = DESK_COMPAT.state) =>
  JSON.stringify({ version, channel: "stable", branch: null, commit: "a".repeat(40), dirty: false, builtAt: "2026-10-01T00:00:00Z", node: "26.10.0", compat: { protocol: [1, 1], state } });
const entry = (installedAt: string, provenance = "release.yml@refs/tags/v0") => ({ channel: "stable", build: "b".repeat(64), provenance, commit: "a".repeat(40), installedAt });

function setup(options: { versions?: string[]; current?: string; previous?: string | null; answers?: (boolean | "no-tty")[]; files?: Record<string, string> } = {}) {
  const versions = options.versions ?? ["0.3.0", "0.3.1", "0.3.2", "0.4.0"];
  const appVersions = new MemoryAppVersions();
  for (const version of versions) {
    appVersions.installed.push(version);
    appVersions.builds.set(version, "b".repeat(64));
  }
  appVersions.currentVersion = options.current ?? "0.4.0";
  const recorded = Object.fromEntries(versions.map((version, index) => [version, entry(`2026-10-0${index + 1}T00:00:00Z`)]));
  const files = new MemoryTextFiles({
    [`${deskHome}/installed.json`]: JSON.stringify({ version: 1, current: appVersions.currentVersion, previous: options.previous === undefined ? "0.3.2" : options.previous, versions: recorded, files: [], futureKey: "kept" }),
    ...Object.fromEntries(versions.map((version) => [`${deskHome}/app/${version}/version.json`, versionJson(version)])),
    ...options.files,
  });
  const lock = new FakeInstanceLock();
  const processes = new FakeProcessInfo();
  const prompter = new ScriptedPrompter(options.answers ?? []);
  const ports = { versions: appVersions, files, lock, processes, prompter, clock: new FakeClock({ auto: true }) };
  return { appVersions, files, lock, processes, prompter, ports };
}

const installed = async (files: MemoryTextFiles) => parseInstalled((await files.read(`${deskHome}/installed.json`)) ?? "");

describe("desk use, rollback and versions (docs/IMPLEMENTATION.md §23.5)", () => {
  it("desk use switches current atomically and records the previous version", async () => {
    const desk = setup({ answers: [true] });

    const result = await useVersion(desk.ports, { deskHome, version: "0.3.2" });

    expect(desk.appVersions.used).toEqual(["0.3.2"]);
    expect(await installed(desk.files)).toMatchObject({ current: "0.3.2", previous: "0.4.0" });
    expect(result).toMatchObject({ code: 0 });
    expect(desk.prompter.asked).toEqual([expect.stringContaining("downgrade")]);
  });

  it("an older Desk keeps the installed.json keys it does not know when it writes the file", async () => {
    const desk = setup({ answers: [true] });

    await useVersion(desk.ports, { deskHome, version: "0.3.2" });

    expect((await installed(desk.files))?.futureKey).toBe("kept");
  });

  it("desk use refuses a version whose state schemas are older than the files on disk", async () => {
    const desk = setup({
      answers: [true],
      files: {
        [`${deskHome}/app/0.3.2/version.json`]: versionJson("0.3.2", { ...DESK_COMPAT.state, layout: 1 }),
        [`${deskHome}/layout.json`]: JSON.stringify({ version: 2, tabs: [] }),
      },
    });

    const result = await useVersion(desk.ports, { deskHome, version: "0.3.2" });

    expect(result).toEqual({ code: 65, message: expect.stringContaining(`${deskHome}/layout.json`) });
    expect(desk.appVersions.used).toEqual([]);
    expect(desk.prompter.asked).toEqual([]);
  });

  it("desk use changes nothing when you decline, and exits 77", async () => {
    const desk = setup({ answers: [false] });

    expect(await useVersion(desk.ports, { deskHome, version: "0.3.2" })).toMatchObject({ code: 77 });
    expect(desk.appVersions.used).toEqual([]);
  });

  it("desk use refuses a version that is not installed", async () => {
    const desk = setup();

    expect(await useVersion(desk.ports, { deskHome, version: "9.9.9" })).toMatchObject({ code: 65 });
  });

  it("desk rollback returns to the previous version", async () => {
    const desk = setup({ answers: [true] });

    await rollbackVersion(desk.ports, { deskHome });

    expect(desk.appVersions.used).toEqual(["0.3.2"]);
    expect(await installed(desk.files)).toMatchObject({ current: "0.3.2", previous: "0.4.0" });
  });

  it("desk rollback says so when there is no previous version", async () => {
    const desk = setup({ previous: null });

    expect(await rollbackVersion(desk.ports, { deskHome })).toEqual({ code: 65, message: "There is no previous version to roll back to" });
  });

  it("desk versions marks current, previous and the versions the daemon, desk watch and native hosts run", async () => {
    const desk = setup();
    desk.lock.holders.set("ptyd", { pid: 4100, build: "0.3.0" });
    desk.lock.holders.set("watch", { pid: 4200, build: "0.4.0" });
    desk.processes.live.add(4300);
    desk.processes.exes.set(4300, `${deskHome}/app/0.3.1/Desk Terminal.app/Contents/MacOS/desk-node`);

    const result = await listVersions(desk.ports, { deskHome });

    expect(result.message.split("\n")).toEqual([
      "0.4.0  stable  release.yml@refs/tags/v0  2026-10-04  current, desk watch",
      "0.3.2  stable  release.yml@refs/tags/v0  2026-10-03  previous",
      "0.3.1  stable  release.yml@refs/tags/v0  2026-10-02  native host",
      "0.3.0  stable  release.yml@refs/tags/v0  2026-10-01  terminal daemon",
    ]);
  });

  it("retention keeps current, previous and the most recently installed other version, and never one a running process uses", async () => {
    const desk = setup({ versions: ["0.2.0", "0.3.0", "0.3.1", "0.3.2", "0.4.0"] });
    desk.lock.holders.set("ptyd", { pid: 4100, build: "0.2.0" });

    await retainVersions(desk.ports, { deskHome });

    expect(desk.appVersions.removed).toEqual(["0.3.0"]);
    expect((await installed(desk.files))?.versions["0.3.0"]).toBeUndefined();
    expect(Object.keys((await installed(desk.files))?.versions ?? {}).sort()).toEqual(["0.2.0", "0.3.1", "0.3.2", "0.4.0"]);
  });

  it("retention never removes a version a running host uses", async () => {
    const desk = setup({ versions: ["0.2.0", "0.3.0", "0.3.1", "0.3.2", "0.4.0"] });
    desk.processes.live.add(4300);
    desk.processes.exes.set(4300, `${deskHome}/app/0.3.0/node/desk-node`);
    desk.processes.live.add(4301);
    desk.processes.exes.set(4301, `${deskHome}/app/0.2.0/node/desk-node`);

    await retainVersions(desk.ports, { deskHome });

    expect(desk.appVersions.removed).toEqual([]);
  });

  it("retention removes nothing when it cannot tell which versions processes run", async () => {
    const desk = setup({ versions: ["0.2.0", "0.3.0", "0.3.1", "0.3.2", "0.4.0"] });
    desk.processes.exesUnknown = true;

    await retainVersions(desk.ports, { deskHome });

    expect(desk.appVersions.removed).toEqual([]);
  });
});
