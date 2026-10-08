import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FILES_SHA256, formatFilesSha256 } from "@desk/core";
import { FakePortProbe, ScriptedPrompter } from "@desk/core/testing";
import { installCommand, releaseInstall } from "../src/install.ts";

const COMMIT = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";

async function runtime(info: Record<string, unknown>): Promise<{ home: string; from: string }> {
  const home = await mkdtemp(join(tmpdir(), "install-release-"));
  const from = join(home, "runtime");
  await mkdir(from);
  const versionJson = JSON.stringify({ version: "0.4.0", channel: "stable", branch: null, commit: COMMIT, dirty: false, builtAt: "2026-10-07T00:00:00Z", node: "26.10.0", compat: {}, ...info });
  await writeFile(join(from, "version.json"), versionJson);
  await writeFile(join(from, FILES_SHA256), formatFilesSha256(new Map([["version.json", createHash("sha256").update(versionJson).digest("hex")]])));
  return { home, from };
}

describe("desk install --from with the release install.sh verified (docs/IMPLEMENTATION.md §23.5)", () => {
  it("desk install --release records release.yml on the release's tag as the provenance, and expects exactly that stable build", () => {
    expect(releaseInstall({ release: { version: "0.4.0", commit: COMMIT }, channel: "stable", current: null })).toEqual({
      provenance: "release.yml@refs/tags/v0.4.0",
      expected: { version: "0.4.0", channel: "stable", commit: COMMIT },
    });
  });

  it("desk install --release expects a stable build whatever channel the runtime calls itself", () => {
    expect(releaseInstall({ release: { version: "0.4.0", commit: COMMIT }, channel: "dev", current: null }).expected).toEqual({ version: "0.4.0", channel: "stable", commit: COMMIT });
  });

  it.each([
    ["older than the current version", "0.5.0", true],
    ["newer than the current version", "0.3.0", false],
    ["the current version", "0.4.0", false],
    ["installed where nothing is current", null, false],
  ])("desk install --release names a downgrade only when the release is %s", (_, current, downgrade) => {
    expect(releaseInstall({ release: { version: "0.4.0", commit: COMMIT }, channel: "stable", current }).downgrade === true).toBe(downgrade);
  });

  it.each([
    ["dev", "dev"],
    ["stable", "directory"],
  ])("desk install --from without --release records %s as %s and expects nothing", (channel, provenance) => {
    expect(releaseInstall({ channel, current: "0.5.0" })).toEqual({ provenance });
  });

  it("desk install --release names a downgrade when the release is older than the current version", async () => {
    const { home, from } = await runtime({});
    const deskHome = join(home, ".desk");
    await mkdir(join(deskHome, "app", "0.5.0"), { recursive: true });
    await symlink("0.5.0", join(deskHome, "app", "current"));
    const prompter = new ScriptedPrompter([false]);

    const result = await installCommand({ from, deskHome, home, platform: "linux", prompter, channel: "stable", probe: new FakePortProbe(), release: { version: "0.4.0", commit: COMMIT } });

    expect(result.code).toBe(77);
    expect(prompter.asked[0]).toMatch(/^This is a downgrade\./);
  });

  it.each([
    ["version", { version: "0.4.1" }],
    ["channel", { channel: "edge" }],
    ["commit", { commit: "1".repeat(40) }],
  ])("desk install --release installs nothing when version.json names another %s", async (_, change) => {
    const { home, from } = await runtime(change);
    const prompter = new ScriptedPrompter([true, true, true, true, true, true]);

    const result = await installCommand({
      from,
      deskHome: join(home, ".desk"),
      home,
      platform: "darwin",
      prompter,
      channel: "stable",
      probe: new FakePortProbe(),
      release: { version: "0.4.0", commit: COMMIT },
    });

    expect(result.code).toBe(65);
    expect(result.message).toContain(`not 0.4.0 (stable, ${COMMIT})`);
    expect(prompter.asked).toEqual([]);
  });
});
