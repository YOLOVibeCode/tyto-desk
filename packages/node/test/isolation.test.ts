import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NodePortProbe,
  TestIsolationError,
  assertPathAllowed,
  assertPortAllowed,
  readIfExists,
  writePrivate,
} from "../src/index.ts";

const realHome = process.env.DESK_TEST_REAL_HOME ?? userInfo().homedir;
/** Writes aim here, never at ~/.desk: if the guard ever failed, the damage would be one stray directory. */
const realHomeProbe = join(realHome, ".desk-test-guard-probe", "probe.json");

/**
 * macOS reaches every home through the `/System/Volumes/Data` firmlink as well, and `realpath` keeps that spelling.
 * Only macOS has it, so only macOS gets the row; Linux has no unprivileged second name for a directory.
 */
const dataVolumeRows: Array<[string, string]> =
  process.platform === "darwin"
    ? [["the real ~/.desk spelled through the Data volume", join("/System/Volumes/Data", realHome, ".desk", "config.json")]]
    : [];

describe("adapter isolation under Vitest", () => {
  it("adapters refuse the real home directory and Desk ports under Vitest", async () => {
    await expect(writePrivate(realHomeProbe, "{}")).rejects.toThrow(/real home directory/);
    await expect(readIfExists(join(realHome, ".desk", "config.json"))).rejects.toThrow(/real home directory/);
    await expect(new NodePortProbe().isFree(9222)).rejects.toThrow(/reserved port 9222/);
    await expect(new NodePortProbe().isFree(9417)).rejects.toThrow(/reserved port 9417/);
  });

  it.each([
    ["the real home itself", realHome],
    ["the real ~/.desk", join(realHome, ".desk", "config.json")],
    ["the real agent-browser config", join(realHome, ".agent-browser", "config.json")],
    ["a path that differs only in case", join(realHome.toUpperCase(), ".desk")],
    ...dataVolumeRows,
  ])("the guard refuses %s", async (_label, path) => {
    await expect(assertPathAllowed(path)).rejects.toThrow(/real home directory/);
  });

  it("the guard refuses a relative path, because adapters take explicit roots", async () => {
    await expect(assertPathAllowed("packages/node/x.json")).rejects.toThrow(/absolute path/);
  });

  it("the guard refuses a .. segment, which the kernel applies after a symlink before it", async () => {
    // <run tmp>/link -> real home, so <run tmp>/link/../<home name>/.desk is the real ~/.desk, while lexically it is
    // <run tmp>/<home name>/.desk. Only the guard is called: no adapter touches the path, even if the guard failed.
    const link = join(await mkdtemp(join(tmpdir(), "guard-")), "link");
    await symlink(realHome, link);
    const sneaky = `${link}/../${basename(realHome)}/.desk/config.json`;

    await expect(assertPathAllowed(sneaky)).rejects.toThrow(TestIsolationError);
  });

  it("the guard refuses a path that reaches the real home through a symlink", async () => {
    const link = join(await mkdtemp(join(tmpdir(), "guard-")), "home-link");
    await symlink(realHome, link);

    await expect(readIfExists(join(link, ".desk", "config.json"))).rejects.toThrow(/real home directory/);
  });

  it.each([9222, 9229, 9400, 9583, 9899])("the guard refuses port %i", (port) => {
    expect(() => assertPortAllowed(port)).toThrow(new RegExp(`reserved port ${port}`));
  });

  it.each([9221, 9399, 9900, 54_321])("the guard allows port %i", (port) => {
    expect(() => assertPortAllowed(port)).not.toThrow();
  });

  it("the guard allows the run's own directories", async () => {
    await expect(assertPathAllowed(join(tmpdir(), "x.json"))).resolves.toBeUndefined();
    await expect(assertPathAllowed(join(process.env.DESK_HOME ?? "", "config.json"))).resolves.toBeUndefined();
  });

  it("the guard is off outside Vitest", async () => {
    const outside = { HOME: realHome };

    await expect(assertPathAllowed(join(realHome, ".desk"), outside)).resolves.toBeUndefined();
    expect(() => assertPortAllowed(9417, outside)).not.toThrow();
  });
});
