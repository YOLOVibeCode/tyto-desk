import { describe, expect, it } from "vitest";
import {
  deskLauncher,
  formatFilesSha256,
  hostLauncher,
  nextInstalled,
  parseFilesSha256,
  parseInstalled,
  parseVersionInfo,
  serializeInstalled,
  terminalBinary,
  versionLine,
  type VersionInfo,
} from "../src/index.ts";

const info: VersionInfo = {
  version: "0.3.1-edge.57+a1b2c3d",
  channel: "edge",
  branch: "main",
  commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  dirty: false,
  builtAt: "2026-10-06T18:00:00Z",
  node: "26.10.0",
  compat: { protocol: [1, 1], state: { config: 1, layout: 1, panes: 1, installed: 1 } },
};

describe("version.json and desk --version", () => {
  it("desk --version prints the version, channel, commit and build time from version.json", () => {
    expect(versionLine(info)).toBe("desk 0.3.1-edge.57+a1b2c3d (edge, a1b2c3d4e5f6 on main, built 2026-10-06T18:00:00Z)");
  });

  it("desk --version names a dirty dev build as dirty", () => {
    const dirty = { ...info, version: "0.3.1-dev.x+a1b2c3d.dirty.20261006t180000z", channel: "dev" as const, branch: "x", dirty: true };

    expect(versionLine(dirty)).toBe(
      "desk 0.3.1-dev.x+a1b2c3d.dirty.20261006t180000z (dev, a1b2c3d4e5f6 on x, dirty, built 2026-10-06T18:00:00Z)",
    );
  });

  it("desk --version leaves the branch out when the build had none", () => {
    expect(versionLine({ ...info, version: "0.3.0", channel: "stable", branch: null })).toBe(
      "desk 0.3.0 (stable, a1b2c3d4e5f6, built 2026-10-06T18:00:00Z)",
    );
  });

  it("version.json round-trips through its parser", () => {
    expect(parseVersionInfo(JSON.stringify(info))).toEqual(info);
  });

  it.each([
    ["text that is not JSON", "{"],
    ["no version", JSON.stringify({ ...info, version: undefined })],
    ["a version that is not SemVer", JSON.stringify({ ...info, version: "latest" })],
    ["an unknown channel", JSON.stringify({ ...info, channel: "nightly" })],
    ["a short commit", JSON.stringify({ ...info, commit: "a1b2c3d" })],
    ["a build time that is not UTC ISO 8601", JSON.stringify({ ...info, builtAt: "yesterday" })],
  ])("a version.json with %s is a damaged install", (_label, text) => {
    expect(parseVersionInfo(text)).toBeNull();
  });
});

describe("files.sha256", () => {
  const digest = (c: string) => c.repeat(64);

  it("files.sha256 lists every file with its sha256, sorted by path, as sha256sum writes it", () => {
    const text = formatFilesSha256(
      new Map([
        ["version.json", digest("b")],
        ["Desk Terminal.app/Contents/MacOS/desk-node", digest("a")],
        ["desk.mjs", digest("c")],
      ]),
    );

    expect(text).toBe(
      `${digest("a")}  Desk Terminal.app/Contents/MacOS/desk-node\n${digest("c")}  desk.mjs\n${digest("b")}  version.json\n`,
    );
    expect(parseFilesSha256(text)).toEqual(
      new Map([
        ["Desk Terminal.app/Contents/MacOS/desk-node", digest("a")],
        ["desk.mjs", digest("c")],
        ["version.json", digest("b")],
      ]),
    );
  });

  it.each([
    ["a line that is not <sha256>  <path>", `${digest("a")} desk.mjs\n`],
    ["an upper-case digest", `${"A".repeat(64)}  desk.mjs\n`],
    ["a path that leaves the directory", `${digest("a")}  ../desk.mjs\n`],
    ["an absolute path", `${digest("a")}  /etc/passwd\n`],
    ["a path listed twice", `${digest("a")}  desk.mjs\n${digest("b")}  desk.mjs\n`],
    ["files.sha256 listing itself", `${digest("a")}  files.sha256\n`],
    ["no files", ""],
  ])("files.sha256 with %s is refused", (_label, text) => {
    expect(parseFilesSha256(text)).toBeNull();
  });
});

describe("the launchers", () => {
  it.each([
    ["darwin", "Desk Terminal.app/Contents/MacOS/desk-node"],
    ["linux", "node/desk-node"],
  ])("on %s Desk Terminal is %s", (platform, path) => {
    expect(terminalBinary(platform)).toBe(path);
  });

  it("the desk launcher resolves current once, runs that version's Desk Terminal with the desk entry, and alone allows the GUI", () => {
    const script = deskLauncher({ deskHome: "/Users/alex/.desk", platform: "darwin" });

    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain(`version=$(cd -P -- '/Users/alex/.desk/app/current' 2>/dev/null && pwd -P)`);
    expect(script).toContain(
      `exec /usr/bin/env -u NODE_OPTIONS -u NODE_PATH -u NODE_REPL_EXTERNAL_MODULE DESK_HOME='/Users/alex/.desk' DESK_ALLOW_GUI=1 ` +
        `"$version/Desk Terminal.app/Contents/MacOS/desk-node" "$version/desk.mjs" "$@"`,
    );
  });

  it("the host launcher runs the nmhost entry of the current version and never allows the GUI", () => {
    const script = hostLauncher({ deskHome: "/Users/alex/.desk", platform: "linux" });

    expect(script).toContain(`"$version/node/desk-node" "$version/desk.mjs" nmhost "$@"`);
    expect(script).not.toContain("DESK_ALLOW_GUI");
  });

  it("a launcher quotes a DESK_HOME with a quote in it", () => {
    expect(deskLauncher({ deskHome: "/Users/o'neil/.desk", platform: "darwin" })).toContain(`DESK_HOME='/Users/o'\\''neil/.desk'`);
  });
});

describe("installed.json", () => {
  const entry = { channel: "dev", build: "9f8e7d6c", provenance: "dev", commit: info.commit, installedAt: "2026-10-07T09:00:00Z" };

  it("the first install records its version as current with no previous", () => {
    const state = nextInstalled(null, { version: "0.3.1-dev.a+a1b2c3d", ...entry }, true);

    expect(state).toEqual({
      version: 1,
      current: "0.3.1-dev.a+a1b2c3d",
      previous: null,
      versions: { "0.3.1-dev.a+a1b2c3d": entry },
      files: [],
    });
  });

  it("switching to another version records the one before as previous", () => {
    const first = nextInstalled(null, { version: "0.3.0", ...entry }, true);
    const second = nextInstalled(first, { version: "0.3.1", ...entry }, true);

    expect(second).toMatchObject({ current: "0.3.1", previous: "0.3.0" });
    expect(Object.keys(second.versions)).toEqual(["0.3.0", "0.3.1"]);
  });

  it("an install the operator did not make current keeps current as it was", () => {
    const first = nextInstalled(null, { version: "0.3.0", ...entry }, true);

    expect(nextInstalled(first, { version: "0.3.1", ...entry }, false)).toMatchObject({ current: "0.3.0", previous: null });
  });

  it("an older Desk keeps the installed.json keys it does not know when it writes the file", () => {
    const text = JSON.stringify({ version: 1, current: "0.3.0", previous: null, versions: {}, files: [], retention: { keep: 4 } });
    const state = parseInstalled(text);
    if (state === null) throw new Error("installed.json did not parse");

    expect(JSON.parse(serializeInstalled(nextInstalled(state, { version: "0.3.1", ...entry }, true)))).toMatchObject({ retention: { keep: 4 } });
  });

  it.each(["{", JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, current: 3 })])("installed.json %s is not read", (text) => {
    expect(parseInstalled(text)).toBeNull();
  });
});
