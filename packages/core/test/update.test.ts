import { describe, expect, it } from "vitest";
import { update, type ReleaseRef, type VersionInfo } from "../src/index.ts";
import {
  FakeArchive,
  FakeClock,
  FakeCodeSigning,
  FakeDaemonClient,
  FakeFileDigest,
  FakeInstanceLock,
  FakeProcessSignals,
  FakeProvenance,
  FakeReleaseFeed,
  MemoryAppVersions,
  MemoryNativeHostDir,
  MemoryTextFiles,
  ScriptedPrompter,
} from "../src/testing/index.ts";

const deskHome = "/Users/alex/.desk";
const home = "/Users/alex";
const COMMIT = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
const EDGE_COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SUM = "c0ffee".repeat(10) + "abcd";

const current = (change: Partial<VersionInfo> = {}): VersionInfo => ({
  version: "0.3.0",
  channel: "stable",
  branch: null,
  commit: "f".repeat(40),
  dirty: false,
  builtAt: "2026-10-01T00:00:00Z",
  node: "26.10.0",
  compat: {},
  ...change,
});
const stable = (version = "0.4.0", tag = `v${version}`): ReleaseRef => ({ tag, version, channel: "stable", commit: COMMIT });
const edge = (version = "0.4.1-edge.57+a1b2c3d"): ReleaseRef => ({ tag: version, version, channel: "edge", commit: EDGE_COMMIT, run: 9001 });

function setup(options: { answers?: (boolean | "no-tty")[]; ref?: ReleaseRef; installed?: string[] } = {}) {
  const feed = new FakeReleaseFeed();
  feed.stable = options.ref ?? stable();
  const provenance = new FakeProvenance();
  const digest = new FakeFileDigest();
  const archive = new FakeArchive();
  const versions = new MemoryAppVersions();
  for (const version of ["0.3.0", ...(options.installed ?? [])]) {
    versions.installed.push(version);
    versions.builds.set(version, "b".repeat(64));
  }
  versions.currentVersion = "0.3.0";
  const files = new MemoryTextFiles();
  const signing = new FakeCodeSigning();
  const daemon = new FakeDaemonClient();
  const signals = new FakeProcessSignals();
  const prompter = new ScriptedPrompter(options.answers ?? [true]);
  // What a download holds: the tarball whose sha256 SHA256SUMS lists, and a runtime that names the release.
  const runtimeFor = (ref: ReleaseRef) => JSON.stringify({ version: ref.version, channel: ref.channel, branch: null, commit: ref.commit, dirty: false, builtAt: "2026-10-07T00:00:00Z", node: "26.10.0", compat: {} });
  let served: ReleaseRef | null = null;
  feed.download = (dir) => {
    digest.digests.set(`${dir}/desk.tar.gz`, SUM);
    void files.write(`${dir}/SHA256SUMS`, `${SUM}  desk-${served?.version ?? "x"}-darwin-arm64.tar.gz\n${"0".repeat(64)}  install.sh\n`, 0o600);
    return { tarball: `${dir}/desk.tar.gz`, sums: `${dir}/SHA256SUMS` };
  };
  const originalFetch = feed.fetch.bind(feed);
  feed.fetch = async (ref, asset, dir) => {
    served = ref;
    return originalFetch(ref, asset, dir);
  };
  archive.onExtract = (dir) => {
    if (served === null) return;
    versions.runtimes.set(dir, { ok: true, staging: `${deskHome}/app/.staging-x`, versionJson: runtimeFor(served), build: "c".repeat(64) });
    signing.valid.add(`${deskHome}/app/.staging-x/Desk Terminal.app`);
  };
  const lock = new FakeInstanceLock();
  const run = (input: { channel?: "stable" | "edge"; version?: string; check?: boolean; info?: VersionInfo } = {}) =>
    update(
      { feed, provenance, digest, archive, lock, versions, signing, prompter, files, hosts: new MemoryNativeHostDir(), clock: new FakeClock({ auto: true }), random: { int: () => 0, id: () => "u_0000000001" } },
      { deskHome, home, platform: "darwin", asset: "darwin-arm64", current: input.info ?? current(), now: "2026-10-07T12:00:00Z", ...input },
    );
  return { feed, provenance, digest, archive, versions, files, signing, daemon, signals, prompter, run };
}

describe("desk update (docs/IMPLEMENTATION.md §23.5)", () => {
  it("desk update installs the newest stable release after its sha256 matches SHA256SUMS, verify-asset passes, and its provenance names release.yml on its tag and commit", async () => {
    const desk = setup();

    const result = await desk.run();

    expect(result).toMatchObject({ code: 0, message: expect.stringContaining("0.4.0") });
    expect(desk.provenance.assets.map((a) => a.file.split("/").pop())).toEqual(["desk.tar.gz", "SHA256SUMS"]);
    expect(desk.provenance.attested).toEqual([{ file: expect.stringMatching(/desk\.tar\.gz$/), workflow: "release.yml", ref: "refs/tags/v0.4.0", commit: COMMIT }]);
    expect(desk.versions.used).toEqual(["0.4.0"]);
  });

  it("desk update checks everything before it extracts anything", async () => {
    const desk = setup();
    desk.provenance.refuseAttestation = true;

    await desk.run();

    expect(desk.archive.extracted).toEqual([]);
  });

  it("desk update installs nothing when the sha256 differs from SHA256SUMS", async () => {
    const desk = setup();
    const original = desk.feed.download;
    desk.feed.download = (dir) => {
      const got = original(dir);
      desk.digest.digests.set(`${dir}/desk.tar.gz`, "1".repeat(64));
      return got;
    };

    expect(await desk.run()).toMatchObject({ code: 65, message: expect.stringContaining("SHA256SUMS") });
    expect(desk.versions.committed).toEqual([]);
  });

  it.each([
    ["provenance", (desk: ReturnType<typeof setup>) => void (desk.provenance.refuseAttestation = true)],
    ["verify-asset", (desk: ReturnType<typeof setup>) => void (desk.provenance.refuseAsset = true)],
  ])("desk update installs nothing when %s is refused", async (_, refuse) => {
    const desk = setup();
    refuse(desk);

    expect(await desk.run()).toMatchObject({ code: 65 });
    expect(desk.versions.committed).toEqual([]);
  });

  it.each(["V0.4.0", "v0.4.0-rc.1", "v0.4", "v00.4.0"])("desk update refuses a release tag that is not exactly vMAJOR.MINOR.PATCH (%s)", async (tag) => {
    const desk = setup({ ref: stable("0.4.0", tag) });

    expect(await desk.run()).toMatchObject({ code: 65, message: expect.stringContaining(tag) });
    expect(desk.feed.fetched).toEqual([]);
  });

  it.each(["stable", "edge"] as const)("desk update refuses a %s ref whose commit is not on main", async (channel) => {
    const desk = setup();
    desk.feed.edge = edge();
    desk.feed.offMain.add(channel === "stable" ? COMMIT : EDGE_COMMIT);

    expect(await desk.run({ channel })).toMatchObject({ code: 65, message: expect.stringContaining("not on main") });
    expect(desk.feed.fetched).toEqual([]);
  });

  it.each([
    ["missing", "brew install gh"],
    ["signed-out", "gh auth login"],
    ["old", "brew upgrade gh"],
  ] as const)("desk update installs nothing when gh is %s (exit 69)", async (reason, fix) => {
    const desk = setup();
    desk.provenance.status = { ok: false, reason };

    expect(await desk.run()).toEqual({ code: 69, message: expect.stringContaining(fix) });
    expect(desk.feed.fetched).toEqual([]);
  });

  it("desk update never installs an older version unless --version names it, and the prompt calls that a downgrade", async () => {
    const older = setup({ ref: stable("0.2.9") });
    const plain = await older.run();
    const named = setup({ ref: stable("0.2.9") });
    named.feed.tagged.set("0.2.9", stable("0.2.9"));
    await named.run({ version: "0.2.9" });

    expect(plain).toEqual({ code: 0, message: "releases/latest (v0.2.9) is older than what you run (0.3.0); nothing changed" });
    expect(older.feed.fetched).toEqual([]);
    expect(named.prompter.asked[0]).toMatch(/downgrade/i);
  });

  it("desk update --channel edge takes the newest successful edge.yml run on main that has the artifact, and verifies edge.yml on refs/heads/main and the run's commit", async () => {
    const desk = setup();
    desk.feed.edge = edge();

    const result = await desk.run({ channel: "edge" });

    expect(result).toMatchObject({ code: 0 });
    expect(desk.provenance.attested).toEqual([{ file: expect.any(String), workflow: "edge.yml", ref: "refs/heads/main", commit: EDGE_COMMIT }]);
    expect(desk.provenance.assets).toEqual([]);
  });

  it("desk update --channel edge refuses a run that does not sort after the current version", async () => {
    const desk = setup();
    desk.feed.edge = edge("0.2.9-edge.3+a1b2c3d");

    expect(await desk.run({ channel: "edge" })).toMatchObject({ code: 65, message: expect.stringContaining("does not sort after") });
  });

  it.each([
    ["version", { version: "0.4.1" }],
    ["channel", { channel: "edge" }],
    ["commit", { commit: "e".repeat(40) }],
  ])("desk update refuses a download whose version.json names another %s", async (_, change) => {
    const desk = setup();
    const extract = desk.archive.onExtract;
    desk.archive.onExtract = (dir) => {
      extract(dir);
      const staged = desk.versions.runtimes.get(dir);
      if (staged?.ok === true) desk.versions.runtimes.set(dir, { ...staged, versionJson: JSON.stringify({ ...JSON.parse(staged.versionJson), ...change }) });
    };

    expect(await desk.run()).toMatchObject({ code: 65, message: expect.stringContaining("version.json") });
    expect(desk.versions.used).toEqual([]);
  });

  it("desk update asks on a TTY before it changes anything and installs nothing when declined", async () => {
    const desk = setup({ answers: [false] });

    expect(await desk.run()).toMatchObject({ code: 77 });
    expect(desk.versions.used).toEqual([]);
  });

  it("desk update never stops the daemon or desk watch", async () => {
    const desk = setup();

    await desk.run();

    expect(desk.daemon.notices).toEqual([]);
    expect(desk.signals.terminated).toEqual([]);
  });

  it("desk update --check prints the newest version per channel and changes nothing", async () => {
    const desk = setup();
    desk.feed.edge = edge();

    const result = await desk.run({ check: true });

    expect(result).toEqual({ code: 0, message: "current: 0.3.0 (stable)\nstable: 0.4.0 (v0.4.0)\nedge: 0.4.1-edge.57+a1b2c3d (run 9001)" });
    expect(desk.feed.fetched).toEqual([]);
  });

  it("desk update on a dev version names npm run deploy and --channel stable", async () => {
    const desk = setup();

    const result = await desk.run({ info: current({ channel: "dev", version: "0.3.1-dev.x+a1b2c3d" }) });

    expect(result).toEqual({ code: 65, message: expect.stringMatching(/npm run deploy.*--channel stable/) });
  });

  it("a version that is already installed is never downloaded again", async () => {
    const desk = setup({ installed: ["0.4.0"] });

    const result = await desk.run();

    expect(desk.feed.fetched).toEqual([]);
    expect(result).toEqual({ code: 0, message: "Desk 0.4.0 is installed already; desk use 0.4.0 makes it current" });
  });

  it("desk update says when GitHub cannot be reached (exit 75)", async () => {
    const desk = setup();
    desk.feed.stable = "unreachable";

    expect(await desk.run()).toMatchObject({ code: 75 });
  });
});
