import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { findInstallHooks, lockedInstallHooks, unreviewedInstallHooks } from "../scripts/lib/install-scripts.mjs";

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

/** A checkout whose package-lock.json lists packages this platform did not install. */
async function lockedCheckout(packages: Record<string, Record<string, unknown>>, allowed = {}) {
  const root = await checkout([], allowed);
  const lock = { name: "x", lockfileVersion: 3, requires: true, packages: { "": { name: "x" }, ...packages } };
  await writeFile(join(root, "package-lock.json"), JSON.stringify(lock));
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

  it("lint:install-scripts fails on a locked package with an install script that this platform did not install", async () => {
    const root = await lockedCheckout({
      "node_modules/fsevents": { version: "2.3.3", hasInstallScript: true, optional: true, os: ["darwin"] },
    });

    const result = await lint(root);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("fsevents@2.3.3");
  });

  it.each([
    ["a locked package", "node_modules/fsevents", { version: "2.3.3" }, "fsevents@2.3.3"],
    ["a scoped locked package", "node_modules/@esbuild/linux-arm64", { version: "0.28.2" }, "@esbuild/linux-arm64@0.28.2"],
    ["a nested locked package", "node_modules/a/node_modules/b", { version: "1.0.0" }, "b@1.0.0"],
    ["an aliased locked package under its real name", "node_modules/alias", { name: "real", version: "1.0.0" }, "real@1.0.0"],
  ])("lint:install-scripts finds %s marked hasInstallScript in the lockfile", async (_label, path, entry, id) => {
    const root = await lockedCheckout({ [path]: { ...entry, hasInstallScript: true } });

    expect(await lockedInstallHooks(root)).toEqual([{ id, hooks: ["install script (package-lock)"], path }]);
  });

  it("lint:install-scripts ignores locked packages the lockfile does not mark hasInstallScript", async () => {
    const root = await lockedCheckout({ "node_modules/plain": { version: "1.0.0" } });

    expect(await lockedInstallHooks(root)).toEqual([]);
  });

  it("lint:install-scripts also fails on an install script in the live image's tools lockfile", async () => {
    const root = await lockedCheckout({});
    const tools = join(root, "test", "live", "image", "tools");
    await mkdir(tools, { recursive: true });
    const lock = {
      name: "desk-live-tools",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "desk-live-tools" },
        "node_modules/agent-browser": { version: "0.38.1", hasInstallScript: true },
      },
    };
    await writeFile(join(tools, "package-lock.json"), JSON.stringify(lock));

    const result = await lint(root);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("agent-browser@0.38.1 (install script (package-lock))  test/live/image/tools/node_modules/agent-browser");
  });

  it("lint:install-scripts passes a locked package that was reviewed at its version", async () => {
    const root = await lockedCheckout(
      { "node_modules/fsevents": { version: "2.3.3", hasInstallScript: true } },
      { "fsevents@2.3.3": "reviewed: ships a prebuilt binary" },
    );

    expect((await lint(root)).code).toBe(0);
  });
});
