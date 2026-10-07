import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nodePin, readNodeRuntime } from "../scripts/delivery/lib/node-runtime.mjs";

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
