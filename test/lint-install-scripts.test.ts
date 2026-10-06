import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { findInstallHooks, unreviewedInstallHooks } from "../scripts/lib/install-scripts.mjs";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/check-install-scripts.mjs", import.meta.url));

type Manifest = { name: string; version: string; scripts?: Record<string, string> };

/** A checkout with an installed dependency tree and an allowlist, in a temp directory. */
async function checkout(packages: Array<{ dir: string; manifest: Manifest; gyp?: boolean }>, allowed = {}) {
  const root = await mkdtemp(join(tmpdir(), "install-scripts-"));
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "scripts", "allowed-install-scripts.json"), JSON.stringify(allowed));
  for (const pkg of packages) {
    const dir = join(root, "node_modules", pkg.dir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify(pkg.manifest));
    if (pkg.gyp) await writeFile(join(dir, "binding.gyp"), "{}");
  }
  return root;
}

async function lint(root: string): Promise<{ code: number; stderr: string }> {
  try {
    await run(process.execPath, [script, "--root", root]);
    return { code: 0, stderr: "" };
  } catch (err) {
    const failure = err as { code?: number; stderr?: string };
    return { code: failure.code ?? -1, stderr: failure.stderr ?? "" };
  }
}

const evil = { dir: "evil", manifest: { name: "evil", version: "1.0.0", scripts: { postinstall: "node steal.js" } } };

describe("lint:install-scripts", () => {
  it("lint:install-scripts fails on an installed package with an install script that is not allowed", async () => {
    const result = await lint(await checkout([evil, { dir: "plain", manifest: { name: "plain", version: "2.0.0" } }]));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("evil@1.0.0 (postinstall)");
    expect(result.stderr).not.toContain("plain@");
  });

  it("lint:install-scripts passes when every install script was reviewed and allowed", async () => {
    const result = await lint(await checkout([evil], { "evil@1.0.0": "reviewed: works without its script" }));

    expect(result.code).toBe(0);
  });

  it("lint:install-scripts allows a package only at the version that was reviewed", async () => {
    const root = await checkout([evil], { "evil@0.9.0": "reviewed: works without its script" });

    expect(unreviewedInstallHooks(await findInstallHooks(root), { "evil@0.9.0": "reviewed" })).toEqual([
      { id: "evil@1.0.0", hooks: ["postinstall"], path: "node_modules/evil" },
    ]);
  });

  it.each([
    ["a preinstall script", { dir: "a", manifest: { name: "a", version: "1.0.0", scripts: { preinstall: "x" } } }, "preinstall", "node_modules/a"],
    ["an install script", { dir: "b", manifest: { name: "b", version: "1.0.0", scripts: { install: "x" } } }, "install", "node_modules/b"],
    ["a binding.gyp, which npm builds with node-gyp", { dir: "c", manifest: { name: "c", version: "1.0.0" }, gyp: true }, "install (node-gyp)", "node_modules/c"],
    ["a scoped package", { dir: "@s/d", manifest: { name: "@s/d", version: "1.0.0", scripts: { postinstall: "x" } } }, "postinstall", "node_modules/@s/d"],
    ["a nested package", { dir: "e/node_modules/f", manifest: { name: "f", version: "1.0.0", scripts: { install: "x" } } }, "install", "node_modules/e/node_modules/f"],
  ])("lint:install-scripts finds %s", async (_label, pkg, hook, path) => {
    const root = await checkout([pkg]);

    expect(await findInstallHooks(root)).toEqual([{ id: `${pkg.manifest.name}@1.0.0`, hooks: [hook], path }]);
  });

  it("lint:install-scripts ignores lifecycle scripts npm does not run on install", async () => {
    const root = await checkout([
      { dir: "g", manifest: { name: "g", version: "1.0.0", scripts: { prepare: "x", build: "y", test: "z" } } },
    ]);

    expect(await findInstallHooks(root)).toEqual([]);
  });
});
