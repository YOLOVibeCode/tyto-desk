import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  findInstallHooks,
  lockedInstallHooks,
  npmProjectProblems,
  npmrcSettings,
  unreviewedInstallHooks,
} from "../scripts/lib/install-scripts.mjs";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/check-install-scripts.mjs", import.meta.url));
const allowlist = fileURLToPath(new URL("../scripts/allowed-install-scripts.json", import.meta.url));

type Manifest = { name: string; version: string; scripts?: Record<string, string> };

/** What every npm project's own .npmrc holds: the repo's supply-chain settings. */
const SETTINGS = "ignore-scripts=true\nsave-exact=true\n";
/** The npm project of its own that the repo has: the live image's tools. */
const TOOLS = "test/live/image/tools";

/** Writes `text` at `path` (relative) under `root`, with its directories. */
async function put(root: string, path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

/** A checkout with an installed dependency tree and an allowlist, in a temp directory. */
async function checkout(packages: Array<{ dir: string; manifest: Manifest; gyp?: boolean }>, allowed = {}) {
  const root = await mkdtemp(join(tmpdir(), "install-scripts-"));
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "scripts", "allowed-install-scripts.json"), JSON.stringify(allowed));
  await writeFile(join(root, ".npmrc"), SETTINGS);
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

/** An npm project of its own at `dir`: a package.json, a package-lock.json unless `lock` is false, and `npmrc`. */
async function npmProject(root: string, dir: string, npmrc: string | null, lock = true): Promise<void> {
  await put(root, `${dir}/package.json`, JSON.stringify({ name: "tools", private: true }));
  if (lock) {
    const lockfile = { name: "tools", lockfileVersion: 3, requires: true, packages: { "": { name: "tools" } } };
    await put(root, `${dir}/package-lock.json`, JSON.stringify(lockfile));
  }
  if (npmrc !== null) await put(root, `${dir}/.npmrc`, npmrc);
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

  it.each([
    ["it runs shell commands", "execSync"],
    ["ldd --version, on Linux", "ldd --version"],
    ["npm prefix -g", "npm prefix -g"],
    ["which, for Chrome on Linux", "`which`"],
    ["the download from GitHub when its binary is absent", "downloads it from the GitHub release"],
    ["that nothing checks the download", "no checksum or signature"],
    ["the marker it writes", "bin/.install-method"],
    ["the relink of a global agent-browser's bin, even on a local install", "even on a local install"],
  ])("the install-script allowlist says everything agent-browser 0.38.1's postinstall would do: %s", async (_label, words) => {
    const allowed = JSON.parse(await readFile(allowlist, "utf8")) as Record<string, string>;

    expect(allowed["agent-browser@0.38.1"]).toContain(words);
  });
});

describe("lint:install-scripts and the repo's npm projects", () => {
  it("lint:install-scripts passes when every npm project sets ignore-scripts=true and save-exact=true in its own .npmrc", async () => {
    const root = await checkout([]);
    await npmProject(root, TOOLS, SETTINGS);

    expect(await lint(root)).toEqual({ code: 0, stderr: "" });
  });

  it.each([
    ["without an .npmrc", null, "test/live/image/tools/.npmrc is missing"],
    ["whose .npmrc does not set ignore-scripts", "save-exact=true\n", "does not set ignore-scripts=true"],
    ["whose .npmrc does not set save-exact", "ignore-scripts=true\n", "does not set save-exact=true"],
    ["whose .npmrc sets ignore-scripts=false", "ignore-scripts=false\nsave-exact=true\n", "does not set ignore-scripts=true"],
    ["whose .npmrc turns ignore-scripts off again further down", `${SETTINGS}ignore-scripts=false\n`, "does not set ignore-scripts=true"],
    ["whose .npmrc sets ignore-scripts only in a comment", "# ignore-scripts=true\nsave-exact=true\n", "does not set ignore-scripts=true"],
    ["whose .npmrc sets ignore-scripts only under a [section]", "save-exact=true\n[tools]\nignore-scripts=true\n", "does not set ignore-scripts=true"],
  ])("lint:install-scripts fails on an npm project of its own %s", async (_label, npmrc, problem) => {
    const root = await checkout([]);
    await npmProject(root, TOOLS, npmrc);

    const result = await lint(root);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(TOOLS);
    expect(result.stderr).toContain(problem);
  });

  it("lint:install-scripts fails when the checkout's own .npmrc does not set ignore-scripts=true and save-exact=true", async () => {
    const root = await checkout([]);
    await writeFile(join(root, ".npmrc"), "fund=false\n");

    expect(await npmProjectProblems(root)).toEqual([".npmrc does not set ignore-scripts=true or save-exact=true"]);
  });

  it("lint:install-scripts fails on an npm project of its own whose lockfile it does not read", async () => {
    const root = await checkout([]);
    await npmProject(root, "test/fixtures/other-tools", SETTINGS);

    const result = await lint(root);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/test\/fixtures\/other-tools is an npm project of its own.*OTHER_LOCKFILE_DIRS/);
  });

  it("lint:install-scripts fails on an npm project of its own without a package-lock.json", async () => {
    const root = await checkout([]);
    await npmProject(root, TOOLS, SETTINGS, false);

    expect(await npmProjectProblems(root)).toEqual([`${TOOLS} has no package-lock.json: every install there must be pinned`]);
  });

  it("lint:install-scripts reads the root's workspaces as the root's own npm project, which its .npmrc covers", async () => {
    const root = await checkout([]);
    await put(root, "package.json", JSON.stringify({ name: "x", workspaces: ["packages/core"] }));
    await put(root, "packages/core/package.json", JSON.stringify({ name: "@x/core" }));

    expect(await npmProjectProblems(root)).toEqual([]);
  });

  it.each([
    ["key=value", "ignore-scripts=true", "true"],
    ["spaces around the =", "  ignore-scripts = true  ", "true"],
    ["a comment after the value", "ignore-scripts=true # every one", "true"],
    ["a quoted value", 'ignore-scripts="true"', "true"],
    ["a bare key, which ini reads as true", "ignore-scripts", "true"],
    ["the last of two lines", "ignore-scripts=true\nignore-scripts=false", "false"],
    ["a commented-out line", "# ignore-scripts=true\n; ignore-scripts=true", undefined],
    ["a key under a [section]", "[section]\nignore-scripts=true", undefined],
  ])("lint:install-scripts reads an .npmrc as npm does: %s", (_label, text, value) => {
    expect(npmrcSettings(text).get("ignore-scripts")).toBe(value);
  });
});
