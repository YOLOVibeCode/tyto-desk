/**
 * Install scripts in the dependency tree (docs/IMPLEMENTATION.md §2 supply chain). `.npmrc` sets ignore-scripts, so
 * none of them runs; this finds every package that declares one, so each is reviewed (it must work without its script)
 * and recorded in scripts/allowed-install-scripts.json at its exact version. It reads both the installed tree and
 * package-lock.json, because an optional package for another platform (fsevents on Linux CI, a linux-arm64 build on
 * the Mac) is never installed where the lint runs, and only the lockfile shows its script there.
 */
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";

/** @typedef {{ id: string; hooks: string[]; path: string }} InstallHook */

const HOOKS = ["preinstall", "install", "postinstall"];

/** @param {unknown} err */
function isMissing(err) {
  return err instanceof Error && "code" in err && (err.code === "ENOENT" || err.code === "ENOTDIR");
}

/** @param {string} path */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

/** @param {string} dir @returns {Promise<string[]>} package directories directly inside a node_modules directory */
async function packageDirs(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  /** @type {string[]} */
  const dirs = [];
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      for (const scoped of (await readdir(join(dir, name))).sort()) {
        if (!scoped.startsWith(".")) dirs.push(join(dir, name, scoped));
      }
    } else {
      dirs.push(join(dir, name));
    }
  }
  return dirs;
}

/**
 * Every installed package under `<root>/node_modules` (scoped, nested, and linked workspaces) that declares
 * preinstall, install or postinstall, or ships a binding.gyp without one (npm then runs `node-gyp rebuild`).
 * @param {string} root
 * @returns {Promise<InstallHook[]>}
 */
export async function findInstallHooks(root) {
  /** @type {InstallHook[]} */
  const found = [];
  const seen = new Set();
  /** @param {string} modules */
  const walk = async (modules) => {
    for (const dir of await packageDirs(modules)) {
      const real = await realpath(dir);
      if (seen.has(real)) continue;
      seen.add(real);
      let manifest = null;
      try {
        manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
      if (manifest !== null) {
        const scripts = typeof manifest.scripts === "object" && manifest.scripts !== null ? manifest.scripts : {};
        const hooks = HOOKS.filter((hook) => typeof scripts[hook] === "string");
        if (!hooks.includes("install") && !hooks.includes("preinstall") && (await exists(join(dir, "binding.gyp")))) {
          hooks.push("install (node-gyp)");
        }
        if (hooks.length > 0) found.push({ id: `${manifest.name}@${manifest.version}`, hooks, path: relative(root, dir) });
      }
      await walk(join(dir, "node_modules"));
    }
  };
  await walk(join(root, "node_modules"));
  return found;
}

/**
 * Every package `<root>/package-lock.json` marks `hasInstallScript` (npm sets it from the published manifest: an
 * install hook, or a binding.gyp at publish time), on every platform, keyed by `name@version` like the installed ones.
 * An aliased package is named as it was published. No lockfile, no hooks.
 * @param {string} root
 * @returns {Promise<InstallHook[]>}
 */
export async function lockedInstallHooks(root) {
  let lock;
  try {
    lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  const packages = typeof lock?.packages === "object" && lock.packages !== null ? lock.packages : {};
  /** @type {InstallHook[]} */
  const found = [];
  for (const path of Object.keys(packages).sort()) {
    const entry = packages[path];
    if (path === "" || typeof entry !== "object" || entry === null || entry.hasInstallScript !== true) continue;
    const at = path.lastIndexOf("node_modules/");
    const name = typeof entry.name === "string" ? entry.name : at === -1 ? path : path.slice(at + "node_modules/".length);
    found.push({ id: `${name}@${entry.version}`, hooks: ["install script (package-lock)"], path });
  }
  return found;
}

/**
 * Other lockfiles whose packages are installed somewhere Desk is tested: the live image installs its npm tools
 * (agent-browser, the Puppeteer and Playwright cores) from this one with `npm ci --ignore-scripts`.
 */
export const OTHER_LOCKFILE_DIRS = ["test/live/image/tools"];

/**
 * The hooks marked in each of OTHER_LOCKFILE_DIRS's package-lock.json, with paths relative to the checkout.
 * @param {string} root
 * @returns {Promise<InstallHook[]>}
 */
async function otherLockedInstallHooks(root) {
  /** @type {InstallHook[]} */
  const found = [];
  for (const dir of OTHER_LOCKFILE_DIRS) {
    for (const hook of await lockedInstallHooks(join(root, dir))) found.push({ ...hook, path: `${dir}/${hook.path}` });
  }
  return found;
}

/**
 * The installed and the locked hooks together (the checkout's and the live image's), one entry per package path and
 * version.
 * @param {string} root
 * @returns {Promise<InstallHook[]>}
 */
export async function allInstallHooks(root) {
  /** @type {Map<string, InstallHook>} */
  const merged = new Map();
  const found = [
    ...(await findInstallHooks(root)),
    ...(await lockedInstallHooks(root)),
    ...(await otherLockedInstallHooks(root)),
  ];
  for (const hook of found) {
    const key = `${hook.path}\0${hook.id}`;
    const known = merged.get(key);
    if (known === undefined) merged.set(key, { ...hook, hooks: [...hook.hooks] });
    else known.hooks.push(...hook.hooks.filter((name) => !known.hooks.includes(name)));
  }
  return [...merged.values()];
}

/**
 * The hooks whose package is not in the allowlist at that exact version.
 * @param {InstallHook[]} found
 * @param {Record<string, string>} allowed `name@version` → why it works without its script
 * @returns {InstallHook[]}
 */
export function unreviewedInstallHooks(found, allowed) {
  return found.filter((hook) => !Object.hasOwn(allowed, hook.id));
}
