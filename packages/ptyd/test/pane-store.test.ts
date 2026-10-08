import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PanesFile } from "@desk/core";
import { NodePaneStore } from "../src/index.ts";

const panes: PanesFile = { version: 1, panes: { p_k2m9q3x7ab: { cwd: "/Users/alex", tmux: null, lastTmux: "work", shell: "/bin/zsh" } } };

async function deskHome(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "panes-")), ".desk");
  await mkdir(dir, { mode: 0o700 });
  return dir;
}

describe("panes.json (docs/IMPLEMENTATION.md §4.1, §7.4)", () => {
  it("PaneStore saves panes.json as a 0600 file and reads it back", async () => {
    const home = await deskHome();
    const store = new NodePaneStore(home);

    await store.save(panes);

    expect(await store.load()).toEqual({ panes, recovered: false });
    expect((await stat(join(home, "panes.json"))).mode & 0o777).toBe(0o600);
  });

  it("PaneStore moves a panes.json it cannot read aside, 0600, and loads nothing", async () => {
    const home = await deskHome();
    await writeFile(join(home, "panes.json"), JSON.stringify({ version: 1, panes: { p_k2m9q3x7ab: { ...panes.panes.p_k2m9q3x7ab, title: "x" } } }));

    const loaded = await new NodePaneStore(home).load();
    const aside = (await readdir(home)).filter((name) => name.startsWith("panes.json.corrupt-"));

    expect(loaded).toEqual({ panes: null, recovered: true });
    expect(aside).toHaveLength(1);
    expect((await stat(join(home, aside[0] ?? ""))).mode & 0o777).toBe(0o600);
  });
});
