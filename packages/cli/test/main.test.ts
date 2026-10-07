import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { newDeskConfig, serializeDeskConfig } from "@desk/core";
import { main } from "../src/index.ts";

const version = {
  version: "0.3.1-edge.57+a1b2c3d",
  channel: "edge",
  branch: "main",
  commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  dirty: false,
  builtAt: "2026-10-06T18:00:00Z",
  node: "26.10.0",
  compat: { protocol: [1, 1], state: { config: 1, layout: 1, panes: 1, installed: 1 } },
};

/** Runs desk's main with a runtime directory holding `versionJson`, and returns its exit code and output. */
/** A Desk config with the Desk Chrome on 9417 and the guarded endpoint on 9583. */
const CONFIG = serializeDeskConfig(newDeskConfig({ home: "/Users/alex", platform: "linux", chromePort: 9417, gatewayPort: 9583 }));

async function desk(argv: string[], versionJson: string | null = JSON.stringify(version), config: string | null = null) {
  const runtimeDir = await mkdtemp(join(tmpdir(), "runtime-"));
  if (versionJson !== null) await writeFile(join(runtimeDir, "version.json"), versionJson);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
  const home = await mkdtemp(join(tmpdir(), "home-"));
  if (config !== null) {
    await mkdir(join(home, ".desk"), { mode: 0o700 });
    await writeFile(join(home, ".desk", "config.json"), config, { mode: 0o600 });
  }
  const code = await main({
    argv,
    env: { HOME: home, DESK_HOME: join(home, ".desk") },
    platform: "linux",
    stdin: new PassThrough(),
    stdout,
    stderr,
    runtimeDir,
  });
  return { code, out, err };
}

describe("the desk command", () => {
  it("desk --version prints the version, channel, commit and build time from version.json", async () => {
    expect(await desk(["--version"])).toEqual({
      code: 0,
      out: "desk 0.3.1-edge.57+a1b2c3d (edge, a1b2c3d4e5f6 on main, built 2026-10-06T18:00:00Z)\n",
      err: "",
    });
  });

  it("desk --version --json prints version.json", async () => {
    const { code, out } = await desk(["--version", "--json"]);

    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual(version);
  });

  it.each([
    ["missing", null],
    ["malformed", "{"],
  ])("desk --version names a damaged install when version.json is %s", async (_label, text) => {
    const { code, err } = await desk(["--version"], text);

    expect(code).toBe(70);
    expect(err).toMatch(/version\.json is missing or damaged/);
  });

  it.each([["launch"], ["--yes"], ["install"], ["install", "--from"], ["quit", "--force"], ["quit", "--all", "--all"], ["cdp", "--guarded"], ["cdp", "--raw", "--raw"], ["tab"], ["tab", "theirs"], ["tab", "current", "mine"]])("desk %s is a usage error (64)", async (...argv) => {
    const { code, err } = await desk(argv);

    expect(code).toBe(64);
    expect(err).toMatch(/^usage: desk/m);
  });

  it("desk quit says the Desk Chrome is not running when Desk has no config yet", async () => {
    expect(await desk(["quit"])).toEqual({ code: 0, out: "The Desk Chrome is not running.\n", err: "" });
  });

  it("desk quit --all refuses without an interactive terminal (64)", async () => {
    expect(await desk(["quit", "--all"])).toEqual({
      code: 64,
      out: "",
      err: "desk: desk quit --all needs an interactive terminal to ask you first\n",
    });
  });

  it("desk cdp prints the guarded endpoint and --raw prints the browser port", async () => {
    expect(await desk(["cdp"], JSON.stringify(version), CONFIG)).toEqual({ code: 0, out: "http://127.0.0.1:9583\n", err: "" });
    expect(await desk(["cdp", "--raw"], JSON.stringify(version), CONFIG)).toEqual({ code: 0, out: "http://127.0.0.1:9417\n", err: "" });
  });

  it("desk cdp exits 69 naming desk when Desk has no config yet", async () => {
    expect(await desk(["cdp"])).toEqual({ code: 69, out: "", err: "desk: Desk has no config yet; run desk\n" });
  });

  it("desk tab mine outside a Desk pane says it needs one (64)", async () => {
    expect(await desk(["tab", "mine"])).toEqual({ code: 64, out: "", err: "desk: desk tab mine runs in a Desk pane, which sets DESK_PANE\n" });
  });

  it("desk tab current exits 69 when Desk is not running", async () => {
    expect(await desk(["tab", "current"])).toEqual({ code: 69, out: "", err: "desk: Desk is not running, or its extension did not answer; run desk\n" });
  });
});
