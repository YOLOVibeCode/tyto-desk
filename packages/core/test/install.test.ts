import { describe, expect, it } from "vitest";
import {
  NATIVE_HOST_NAME,
  deskLauncher,
  hostLauncher,
  installVersion,
  nativeHostManifest,
  parseInstalled,
  type VersionInfo,
} from "../src/index.ts";
import {
  FakeClock,
  FakeCodeSigning,
  FakeInstanceLock,
  MemoryAppVersions,
  MemoryNativeHostDir,
  MemoryTextFiles,
  ScriptedPrompter,
} from "../src/testing/index.ts";

const home = "/Users/alex";
const deskHome = "/Users/alex/.desk";
const from = "/Users/alex/Dev/tyto-desk/dist/desk-0.3.1-dev.slice-1c+a1b2c3d";
const staging = `${deskHome}/app/.staging-k2m9q3x7ab`;
const info: VersionInfo = {
  version: "0.3.1-dev.slice-1c+a1b2c3d",
  channel: "dev",
  branch: "slice-1c/walking-skeleton",
  commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  dirty: false,
  builtAt: "2026-10-07T09:00:00Z",
  node: "26.10.0",
  compat: {},
};

/** The staged runtime's build id: the sha256 of its files.sha256. */
const BUILD = "9f8e7d6c".repeat(8);

function setup(options: { answers?: (boolean | "no-tty")[]; platform?: string; signed?: boolean } = {}) {
  const versions = new MemoryAppVersions();
  versions.runtimes.set(from, { ok: true, staging, versionJson: JSON.stringify(info), build: BUILD });
  const signing = new FakeCodeSigning();
  if (options.signed ?? true) signing.valid.add(`${staging}/Desk Terminal.app`);
  const prompter = new ScriptedPrompter(options.answers ?? [true]);
  const files = new MemoryTextFiles();
  const hosts = new MemoryNativeHostDir();
  const lock = new FakeInstanceLock();
  const run = () =>
    installVersion(
      { lock, versions, signing, prompter, files, hosts, clock: new FakeClock({ auto: true }) },
      { from, deskHome, home, platform: options.platform ?? "darwin", provenance: "dev", now: "2026-10-07T09:30:00Z" },
    );
  return { versions, signing, prompter, files, hosts, lock, run };
}

describe("desk install --from", () => {
  it("install verifies the runtime, asks on a TTY, renames it into place and switches current", async () => {
    const desk = setup();

    const result = await desk.run();

    expect(result).toEqual({ ok: true, version: info.version, message: `Installed ${info.version}; run desk` });
    expect(desk.signing.verified).toEqual([`${staging}/Desk Terminal.app`]);
    expect(desk.versions.committed).toEqual([`${staging} -> ${info.version}`]);
    expect(desk.prompter.asked).toEqual([
      `Make Desk ${info.version} the current version? Running shells and tmux sessions keep running; the next desk loads it.`,
    ]);
    expect(desk.versions.used).toEqual([info.version]);
  });

  it("install records the version in installed.json as current, with the one before as previous", async () => {
    const desk = setup();
    desk.versions.installed.push("0.3.0");
    desk.versions.currentVersion = "0.3.0";

    await desk.run();

    expect(parseInstalled(desk.files.text(`${deskHome}/installed.json`))).toEqual({
      version: 1,
      current: info.version,
      previous: "0.3.0",
      versions: {
        [info.version]: { channel: "dev", build: "9f8e7d6c".repeat(8), provenance: "dev", commit: info.commit, installedAt: "2026-10-07T09:30:00Z" },
      },
      files: [],
    });
    expect(desk.files.files.get(`${deskHome}/installed.json`)?.mode).toBe(0o600);
  });

  it("install writes the launchers, which resolve current, and the Desk host manifest", async () => {
    const desk = setup();

    await desk.run();

    expect(desk.files.files.get(`${home}/.local/bin/desk`)).toEqual({ text: deskLauncher({ deskHome, platform: "darwin" }), mode: 0o700 });
    expect(desk.files.files.get(`${deskHome}/bin/desk-nmhost`)).toEqual({ text: hostLauncher({ deskHome, platform: "darwin" }), mode: 0o700 });
    expect(desk.hosts.manifests.get(NATIVE_HOST_NAME)).toBe(nativeHostManifest(deskHome));
  });

  it("install holds run/install.lock and releases it", async () => {
    const desk = setup();

    await desk.run();

    expect(desk.lock.acquired).toEqual(["install"]);
    expect(desk.lock.released).toEqual(["install"]);
  });

  it("install refuses a runtime that does not match its files.sha256 and installs nothing", async () => {
    const desk = setup();
    desk.versions.runtimes.set(from, { ok: false, reason: "mismatch" });

    const result = await desk.run();

    expect(result).toMatchObject({ ok: false, code: 65 });
    expect(desk.versions.committed).toEqual([]);
    expect(desk.prompter.asked).toEqual([]);
  });

  it("install refuses a runtime whose version.json is damaged, and removes its staging", async () => {
    const desk = setup();
    desk.versions.runtimes.set(from, { ok: true, staging, versionJson: "{}", build: "0".repeat(64) });

    expect(await desk.run()).toMatchObject({ ok: false, code: 65 });
    expect(desk.versions.discarded).toEqual([staging]);
    expect(desk.versions.committed).toEqual([]);
  });

  it("install refuses a runtime whose Desk Terminal fails codesign --verify on macOS", async () => {
    const desk = setup({ signed: false });

    expect(await desk.run()).toMatchObject({ ok: false, code: 65 });
    expect(desk.versions.discarded).toEqual([staging]);
  });

  it("install checks no code signature on Linux", async () => {
    const desk = setup({ platform: "linux", signed: false });

    expect(await desk.run()).toMatchObject({ ok: true });
    expect(desk.signing.verified).toEqual([]);
  });

  it("install switches nothing when the operator declines, and exits 77", async () => {
    const desk = setup({ answers: [false] });

    const result = await desk.run();

    expect(result).toMatchObject({ ok: false, code: 77 });
    expect(desk.versions.used).toEqual([]);
    expect(desk.files.files.has(`${home}/.local/bin/desk`)).toBe(false);
  });

  it("install refuses to switch current without an interactive terminal, and exits 64", async () => {
    const desk = setup({ answers: ["no-tty"] });

    expect(await desk.run()).toMatchObject({ ok: false, code: 64, message: expect.stringContaining("interactive terminal") });
    expect(desk.versions.used).toEqual([]);
  });

  it("installing an installed version renames nothing into place again", async () => {
    const desk = setup();
    desk.versions.installed.push(info.version);
    desk.versions.builds.set(info.version, BUILD);

    await desk.run();

    expect(desk.versions.committed).toEqual([]);
    expect(desk.versions.discarded).toEqual([staging]);
    expect(desk.versions.used).toEqual([info.version]);
  });

  it("installing an installed version keeps the build and install time installed.json recorded for it", async () => {
    const desk = setup();
    desk.versions.installed.push(info.version, "0.3.0");
    desk.versions.currentVersion = "0.3.0";
    desk.versions.builds.set(info.version, "a1".repeat(32));
    const recorded = { channel: "dev", build: "a1".repeat(32), provenance: "dev", commit: info.commit, installedAt: "2026-10-01T08:00:00Z" };
    desk.files.files.set(`${deskHome}/installed.json`, {
      text: JSON.stringify({ version: 1, current: "0.3.0", previous: null, versions: { [info.version]: recorded }, files: [] }),
      mode: 0o600,
    });

    await desk.run();

    expect(parseInstalled(desk.files.text(`${deskHome}/installed.json`))).toMatchObject({
      current: info.version,
      previous: "0.3.0",
      versions: { [info.version]: recorded },
    });
  });

  it("installing an installed version that installed.json does not record records the installed copy's build, not the discarded one's", async () => {
    const desk = setup();
    desk.versions.installed.push(info.version);
    desk.versions.builds.set(info.version, "b2".repeat(32));

    await desk.run();

    expect(parseInstalled(desk.files.text(`${deskHome}/installed.json`))?.versions[info.version]?.build).toBe("b2".repeat(32));
  });

  it("installing an installed version from another build of it says the installed copy stays as it was", async () => {
    const desk = setup();
    desk.versions.installed.push(info.version);
    desk.versions.builds.set(info.version, "b2".repeat(32));

    expect(await desk.run()).toMatchObject({ ok: true, message: expect.stringContaining("the installed copy stays as it was") });
  });

  it("install refuses an installed version whose installed copy has no files.sha256, and changes nothing", async () => {
    const desk = setup();
    desk.versions.installed.push(info.version);

    expect(await desk.run()).toMatchObject({ ok: false, code: 65, message: expect.stringContaining("damaged") });
    expect(desk.versions.used).toEqual([]);
    expect(desk.files.files.has(`${deskHome}/installed.json`)).toBe(false);
  });

  it("install refuses a damaged installed.json before it asks or switches current, and changes nothing", async () => {
    const desk = setup();
    desk.files.files.set(`${deskHome}/installed.json`, { text: "{ not json", mode: 0o600 });

    expect(await desk.run()).toMatchObject({ ok: false, code: 65, message: expect.stringContaining("installed.json is damaged") });
    expect(desk.prompter.asked).toEqual([]);
    expect(desk.versions.used).toEqual([]);
    expect(desk.versions.committed).toEqual([]);
    expect(desk.files.files.has(`${home}/.local/bin/desk`)).toBe(false);
  });

  it("installing the current version asks nothing and rewrites the launchers", async () => {
    const desk = setup({ answers: [] });
    desk.versions.installed.push(info.version);
    desk.versions.currentVersion = info.version;
    desk.versions.builds.set(info.version, BUILD);

    const result = await desk.run();

    expect(result).toEqual({ ok: true, version: info.version, message: `${info.version} is installed and current; run desk` });
    expect(desk.files.files.has(`${home}/.local/bin/desk`)).toBe(true);
  });

  it("install exits 75 while another install holds run/install.lock", async () => {
    const desk = setup();
    desk.lock.heldBy.set("install", 4242);

    expect(await desk.run()).toMatchObject({ ok: false, code: 75 });
    expect(desk.versions.committed).toEqual([]);
  });
});
