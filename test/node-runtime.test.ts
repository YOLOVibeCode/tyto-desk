import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nodePin, parseNodeRuntime, readNodeRuntime } from "../scripts/delivery/lib/node-runtime.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));

describe("Desk Terminal's pinned Node (scripts/delivery/node-runtime.json, docs/IMPLEMENTATION.md §15.1, §23.6)", () => {
  it("Desk Terminal's Node is the version .nvmrc names", async () => {
    const runtime = await readNodeRuntime(repo);

    expect(runtime.version).toBe((await readFile(`${repo}.nvmrc`, "utf8")).trim());
  });

  it("Desk Terminal's Node for darwin-arm64 is pinned by the sha256 of nodejs.org's tarball and of its bin/node", async () => {
    const pin = nodePin(await readNodeRuntime(repo), "darwin", "arm64");

    expect(pin).toEqual({
      archive: "node-v26.10.0-darwin-arm64.tar.gz",
      archiveSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      binarySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("the live container's Node is pinned by the same tarball the live image installs", async () => {
    const pin = nodePin(await readNodeRuntime(repo), "linux", "arm64");
    const dockerfile = await readFile(`${repo}test/live/image/Dockerfile`, "utf8");

    expect(pin?.archive).toBe("node-v26.10.0-linux-arm64.tar.xz");
    expect(dockerfile).toContain(`ARG NODE_SHA256=${pin?.archiveSha256}`);
    expect(dockerfile).toContain("ARG NODE_VERSION=26.10.0");
  });

  it.each([
    ["darwin", "x64"],
    ["win32", "arm64"],
    ["linux", "x64"],
  ])("there is no pinned Node for %s-%s, where Desk does not run", async (platform, arch) => {
    expect(nodePin(await readNodeRuntime(repo), platform, arch)).toBeNull();
  });
});

describe("the Node pin refuses what it cannot trust (the security reviews of PR #8)", () => {
  /** The repo's pin, as JSON, with `change` applied to a copy. */
  async function pinWith(change: (pin: Record<string, unknown> & { platforms: Record<string, Record<string, unknown>> }) => void): Promise<unknown> {
    const pin = JSON.parse(await readFile(`${repo}scripts/delivery/node-runtime.json`, "utf8")) as Record<string, unknown> & {
      platforms: Record<string, Record<string, unknown>>;
    };
    change(pin);
    return pin;
  }

  it("the pin names nodejs.org's own directory for its version as its source", async () => {
    expect((await readNodeRuntime(repo)).source).toBe("https://nodejs.org/dist/v26.10.0/");
  });

  it.each<[string, (pin: Record<string, unknown> & { platforms: Record<string, Record<string, unknown>> }) => void, RegExp]>([
    ["a version that is not X.Y.Z", (pin) => (pin.version = "26.10"), /exact Node version/],
    ["a version with a leading zero", (pin) => (pin.version = "26.010.0"), /exact Node version/],
    ["a source other than nodejs.org's directory for the version", (pin) => (pin.source = "https://example.com/dist/v26.10.0/"), /source/],
    ["no source", (pin) => delete pin.source, /source/],
    ["no platforms", (pin) => delete (pin as Record<string, unknown>).platforms, /platforms/],
    ["a platform Desk does not build for", (pin) => (pin.platforms["darwin-x64"] = { ...pin.platforms["darwin-arm64"] }), /darwin-x64/],
    ["a __proto__ platform", (pin) => Object.defineProperty(pin.platforms, "__proto__", { value: {}, enumerable: true }), /__proto__/],
    ["a missing platform", (pin) => delete pin.platforms["linux-arm64"], /linux-arm64/],
    ["an entry that is not an object", (pin) => ((pin.platforms as Record<string, unknown>)["darwin-arm64"] = null), /darwin-arm64/],
    ["an archive path that leaves the directory", (pin) => ((pin.platforms["darwin-arm64"] ?? {}).archive = "../../etc/node.tar.gz"), /archive/],
    ["an archive of another version", (pin) => ((pin.platforms["darwin-arm64"] ?? {}).archive = "node-v26.9.0-darwin-arm64.tar.gz"), /archive/],
    ["an archive of another platform", (pin) => ((pin.platforms["darwin-arm64"] ?? {}).archive = "node-v26.10.0-linux-arm64.tar.gz"), /archive/],
    ["a digest of the wrong length", (pin) => ((pin.platforms["darwin-arm64"] ?? {}).archiveSha256 = "ab"), /darwin-arm64/],
    ["a digest in capitals", (pin) => ((pin.platforms["linux-arm64"] ?? {}).binarySha256 = "A".repeat(64)), /linux-arm64/],
  ])("the pin is refused with %s", async (_, change, why) => {
    const pin = await pinWith(change);

    expect(() => parseNodeRuntime(pin)).toThrow(why);
  });

  it.each([
    ["is not JSON", "{ not json"],
    ["is not an object", "[]\n"],
  ])("readNodeRuntime refuses a pin file that %s", async (_, text) => {
    const root = await mkdtemp(join(tmpdir(), "pin-"));
    await mkdir(join(root, "scripts", "delivery"), { recursive: true });
    await writeFile(join(root, "scripts", "delivery", "node-runtime.json"), text);

    await expect(readNodeRuntime(root)).rejects.toThrow(/node-runtime\.json/);
  });

  it("readNodeRuntime refuses a checkout without a pin file", async () => {
    await expect(readNodeRuntime(await mkdtemp(join(tmpdir(), "pin-")))).rejects.toThrow(/node-runtime\.json/);
  });
});
