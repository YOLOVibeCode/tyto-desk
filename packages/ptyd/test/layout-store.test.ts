import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Layout } from "@desk/core";
import { NodeLayoutStore } from "../src/index.ts";

const PANE = "p_k2m9q3x7ab";
const layout: Layout = { version: 1, activeTab: "t_k2m9q3x7ab", ui: { fontSize: 14 }, tabs: [{ id: "t_k2m9q3x7ab", focus: PANE, zoomed: null, root: { pane: PANE } }] };

async function deskHome(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "layout-")), ".desk");
  await mkdir(dir, { mode: 0o700 });
  return dir;
}

describe("layout.json (docs/IMPLEMENTATION.md §4.1, §4.3)", () => {
  it("LayoutStore saves layout.json as a 0600 file and reads it back", async () => {
    const home = await deskHome();
    const store = new NodeLayoutStore(home);

    await store.save(layout);

    expect(await store.load()).toEqual({ layout, recovered: false });
    expect((await stat(join(home, "layout.json"))).mode & 0o777).toBe(0o600);
  });

  it("LayoutStore reads no layout when there is none", async () => {
    expect(await new NodeLayoutStore(await deskHome()).load()).toEqual({ layout: null, recovered: false });
  });

  it.each([
    ["does not parse", "{ not json"],
    ["has an unknown key", JSON.stringify({ ...layout, extra: true })],
    ["has a newer version", JSON.stringify({ ...layout, version: 2 })],
  ])("a layout.json that %s is moved aside as layout.json.corrupt-<UTC time>, 0600, and nothing is loaded", async (_, text) => {
    const home = await deskHome();
    await writeFile(join(home, "layout.json"), text, { mode: 0o600 });

    const loaded = await new NodeLayoutStore(home).load();
    const names = await readdir(home);
    const aside = names.find((name) => /^layout\.json\.corrupt-\d{8}T\d{6}Z$/.test(name));

    expect(loaded).toEqual({ layout: null, recovered: true });
    expect(names).not.toContain("layout.json");
    expect(aside).toBeDefined();
    expect(await readFile(join(home, aside ?? ""), "utf8")).toBe(text);
    expect((await stat(join(home, aside ?? ""))).mode & 0o777).toBe(0o600);
  });
});
