import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newDeskConfig, serializeDeskConfig } from "../../core/src/index.ts";
import { ConfigFileError, FileConfigStore } from "../src/index.ts";

const config = newDeskConfig({ home: "/Users/alex", platform: "darwin", chromePort: 9417, gatewayPort: 9583 });

describe("FileConfigStore", () => {
  it("the config store saves config.json as a 0600 file and loads it back", async () => {
    const deskHome = join(await mkdtemp(join(tmpdir(), "config-")), ".desk");
    const store = new FileConfigStore(deskHome);

    await store.save(config);

    expect(await store.load()).toEqual(config);
    expect(await readFile(join(deskHome, "config.json"), "utf8")).toBe(serializeDeskConfig(config));
    expect((await stat(join(deskHome, "config.json"))).mode & 0o777).toBe(0o600);
  });

  it("the config store loads nothing before the first save", async () => {
    expect(await new FileConfigStore(join(await mkdtemp(join(tmpdir(), "config-")), ".desk")).load()).toBeNull();
  });

  it("the config store refuses a config.json the schema refuses, naming the problem and never the file's text", async () => {
    const deskHome = join(await mkdtemp(join(tmpdir(), "config-")), ".desk");
    await mkdir(deskHome);
    await writeFile(join(deskHome, "config.json"), '{"version": 1, "secret": "do-not-print"}');

    const failure = await new FileConfigStore(deskHome).load().catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ConfigFileError);
    expect(String(failure)).not.toContain("do-not-print");
    expect(failure).toMatchObject({ problem: "unknown-key", path: "secret" });
  });
});
