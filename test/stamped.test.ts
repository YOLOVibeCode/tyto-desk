import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DESK_COMPAT, type VersionInfo } from "../packages/core/src/index.ts";
import { stampedVersion } from "../scripts/lib/stamped.mjs";
import { fileURLToPath } from "node:url";
import { gitCheckout, gitEnv, runScript } from "./delivery/helpers.ts";

/** GitHub Actions as `npm run pack` sees it in build-darwin.yml, after the workflow's stamp step. */
const actions = { ...gitEnv, GITHUB_ACTIONS: "true" };

function stampedFor(commit: string): VersionInfo {
  return {
    version: "0.3.1-edge.57+a1b2c3d",
    channel: "edge",
    branch: "main",
    commit,
    dirty: false,
    builtAt: "2026-10-07T09:00:00Z",
    node: "26.10.0",
    compat: DESK_COMPAT,
  };
}

/** A checkout whose dist/version.json holds `text`, or has none. */
async function checkoutWith(text: (head: string) => string | null): Promise<string> {
  const { root, head } = await gitCheckout({ "package.json": `${JSON.stringify({ name: "x", version: "0.3.0" })}\n`, ".gitignore": "dist/\n" });
  const written = text(head);
  if (written !== null) {
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "version.json"), written);
  }
  return root;
}

describe("the version npm run pack takes (docs/IMPLEMENTATION.md §23.3, D93)", () => {
  it("in GitHub Actions the pack takes the dist/version.json the workflow's stamp step wrote for this commit", async () => {
    let head = "";
    const root = await checkoutWith((commit) => {
      head = commit;
      return `${JSON.stringify(stampedFor(commit))}\n`;
    });

    expect(await stampedVersion({ root, env: actions, allowDirty: false })).toEqual({ ok: true, version: stampedFor(head) });
  });

  it.each([
    ["missing", () => null],
    ["damaged", () => "{ not json"],
    ["not a version.json", () => `${JSON.stringify({ version: "0.3.1" })}\n`],
  ])("in GitHub Actions the pack refuses a dist/version.json that is %s", async (_label, text) => {
    const root = await checkoutWith(text);

    expect(await stampedVersion({ root, env: actions, allowDirty: false })).toEqual({
      ok: false,
      reasons: ["dist/version.json is missing or damaged: run the stamp step first"],
    });
  });

  it("in GitHub Actions the pack refuses a dist/version.json that names another commit than the one checked out", async () => {
    const root = await checkoutWith(() => `${JSON.stringify(stampedFor("0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c"))}\n`);

    expect(await stampedVersion({ root, env: actions, allowDirty: false })).toEqual({
      ok: false,
      reasons: ["dist/version.json names another commit than the one checked out"],
    });
  });

  it("locally the pack refuses a Node pin it cannot trust with a reason, never an exception", async () => {
    const { root } = await gitCheckout(
      { "package.json": `${JSON.stringify({ name: "x", version: "0.3.0" })}\n`, ".gitignore": "dist/\n", "scripts/delivery/node-runtime.json": "not json" },
      "slice-1c/walking-skeleton",
    );

    expect(await stampedVersion({ root, env: gitEnv, allowDirty: false })).toEqual({ ok: false, reasons: ["node-pin: node-runtime.json is not JSON"] });
  });

  it("locally a refused build with a refused Node pin names both", async () => {
    const { root } = await gitCheckout(
      { "package.json": `${JSON.stringify({ name: "x", version: "0.3" })}\n`, ".gitignore": "dist/\n", "scripts/delivery/node-runtime.json": "not json" },
      "slice-1c/walking-skeleton",
    );

    const stamped = await stampedVersion({ root, env: gitEnv, allowDirty: false });

    expect(stamped.ok).toBe(false);
    expect(stamped.ok ? [] : stamped.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/^bad-base-version: /), "node-pin: node-runtime.json is not JSON"]));
  });

  it("in GitHub Actions npm run pack refuses a Node pin it cannot trust in one line with 65", async () => {
    let head = "";
    const root = await checkoutWith((commit) => {
      head = commit;
      return `${JSON.stringify(stampedFor(commit))}\n`;
    });
    await mkdir(join(root, "scripts", "delivery"), { recursive: true });
    await writeFile(join(root, "scripts", "delivery", "node-runtime.json"), "not json");

    const packed = await runScript(fileURLToPath(new URL("../scripts/pack.mjs", import.meta.url)), [], { cwd: root, env: actions });

    expect(head).not.toBe("");
    expect(packed.code).toBe(65);
    expect(packed.stderr.trim().split("\n")).toEqual(["pack: the Node pin is refused (node-runtime.json is not JSON)"]);
  });
});
