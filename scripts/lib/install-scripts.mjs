/**
 * Install scripts in the installed dependency tree (docs/IMPLEMENTATION.md §2 supply chain). `.npmrc` sets
 * ignore-scripts, so none of them runs; this finds every package that declares one, so each is reviewed (it must work
 * without its script) and recorded in scripts/allowed-install-scripts.json at its exact version.
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
 * The hooks whose package is not in the allowlist at that exact version.
 * @param {InstallHook[]} found
 * @param {Record<string, string>} allowed `name@version` → why it works without its script
 * @returns {InstallHook[]}
 */
export function unreviewedInstallHooks(found, allowed) {
  return found.filter((hook) => !Object.hasOwn(allowed, hook.id));
}
