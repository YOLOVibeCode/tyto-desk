/**
 * Install scripts in the dependency tree (docs/IMPLEMENTATION.md §2 supply chain). `.npmrc` sets ignore-scripts, so
 * none of them runs; this finds every package that declares one, so each is reviewed (it must work without its script)
 * and recorded in scripts/allowed-install-scripts.json at its exact version. It reads both the installed tree and
 * package-lock.json, because an optional package for another platform (fsevents on Linux CI, a linux-arm64 build on
 * the Mac) is never installed where the lint runs, and only the lockfile shows its script there.
 *
 * npm reads only the .npmrc of the project it runs in, so it also checks that every npm project in the checkout (the
 * root, and each directory that is a project of its own, such as the live image's tools) sets ignore-scripts and
 * save-exact in its own .npmrc, and that each project of its own is one whose lockfile it reads.
 */
import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

/** @typedef {{ id: string; hooks: string[]; path: string }} InstallHook */

const execFileP = promisify(execFile);

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
 * The npm projects of their own in the checkout, other than the root and its workspaces, whose lockfiles this lint
 * reads: the live image installs its npm tools (agent-browser, the Puppeteer and Playwright cores) from this one with
 * `npm ci --ignore-scripts`. npmProjectProblems fails on a project of its own that is not listed here.
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

/**
 * What every npm project in the repo sets to `true` in its own .npmrc (§2 supply chain): no install script runs, and
 * every pin npm saves is exact. npm reads the .npmrc of the project it runs in (the nearest directory up with a
 * package.json, or the root above it when that directory is one of the root's workspaces), and never the root's from
 * inside a project of its own.
 */
export const NPM_PROJECT_SETTINGS = ["ignore-scripts", "save-exact"];

/** The files whose directory npm runs in as a project of its own. */
const PROJECT_FILES = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json"]);

/** What the walk for npm projects skips outside a git checkout: dependencies, git's files, build and test output. */
const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", "test-results"]);

/**
 * One value as npm's ini parser reads it: a quoted value whole (as JSON when it parses), or else everything up to the
 * first `;` or `#` that no backslash escapes, trimmed.
 * @param {string} raw
 */
function iniValue(raw) {
  const value = raw.trim();
  const quote = value.charAt(0);
  if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
    const text = quote === "'" ? value.slice(1, -1) : value;
    try {
      return String(JSON.parse(text));
    } catch {
      return text;
    }
  }
  let read = "";
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charAt(i);
    const next = value.charAt(i + 1);
    if (c === "\\" && next !== "" && ";#\\".includes(next)) {
      read += next;
      i += 1;
    } else if (c === ";" || c === "#") {
      break;
    } else {
      read += c;
    }
  }
  return read.trim();
}

/**
 * The top-level settings of an .npmrc as npm reads them (its ini format): `key = value` lines, the last line of a key
 * winning; a line that starts with `#` or `;` is a comment; a bare key is `true`; keys after a `[section]` header belong
 * to that section, where none of npm's own settings is read.
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function npmrcSettings(text) {
  /** @type {Map<string, string>} */
  const settings = new Map();
  for (const raw of text.split(/[\r\n]+/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (/^\[[^\]]*\]$/.test(line)) break;
    const eq = line.indexOf("=");
    if (eq === -1) settings.set(line, "true");
    else settings.set(line.slice(0, eq).trim(), iniValue(line.slice(eq + 1)));
  }
  return settings;
}

/**
 * The directories that are npm projects of their own: each one, other than the root and the root's workspaces, that
 * holds a package.json, package-lock.json or npm-shrinkwrap.json outside node_modules. npm runs in each with that
 * directory's .npmrc. Workspaces are plain relative paths, as the live harness requires too.
 * @param {readonly string[]} files the checkout's files, relative and `/`-separated
 * @param {readonly string[]} workspaces the root package.json's workspaces
 * @returns {string[]} sorted by code unit
 */
export function separateNpmProjects(files, workspaces) {
  /** @type {Set<string>} */
  const dirs = new Set();
  for (const file of files) {
    const slash = file.lastIndexOf("/");
    if (slash === -1 || !PROJECT_FILES.has(file.slice(slash + 1))) continue;
    const dir = file.slice(0, slash);
    if (!dir.split("/").includes("node_modules") && !workspaces.includes(dir)) dirs.add(dir);
  }
  return [...dirs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The checkout's files, relative and `/`-separated: in a git checkout, the files git tracks and the untracked ones it
 * does not ignore; elsewhere, every file outside SKIPPED_DIRS. A link is never followed.
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function checkoutFiles(root) {
  if (await exists(join(root, ".git"))) {
    const { stdout } = await execFileP("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      signal: AbortSignal.timeout(60_000),
    });
    return stdout.split("\0").filter((file) => file !== "");
  }
  /** @type {string[]} */
  const files = [];
  /** @param {string} dir */
  const walk = async (dir) => {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  await walk("");
  return files;
}

/** @param {string} root @returns {Promise<string[]>} the root package.json's workspaces; none without one */
async function rootWorkspaces(root) {
  /** @type {unknown} */
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  const workspaces = typeof manifest === "object" && manifest !== null && "workspaces" in manifest ? manifest.workspaces : [];
  return Array.isArray(workspaces) ? workspaces.filter((workspace) => typeof workspace === "string") : [];
}

/**
 * The npm projects of their own in the checkout at `root` (separateNpmProjects over its files and workspaces).
 * @param {string} root
 * @returns {Promise<string[]>}
 */
export async function separateNpmProjectsIn(root) {
  return separateNpmProjects(await checkoutFiles(root), await rootWorkspaces(root));
}

/**
 * How the checkout's npm projects break the repo's supply-chain settings, one line each; none when they keep them.
 * Every project, the root's included, sets ignore-scripts=true and save-exact=true in its own .npmrc; every project of
 * its own is listed in OTHER_LOCKFILE_DIRS, so this lint reviews its lockfile's install scripts, and has a
 * package-lock.json.
 * @param {string} root
 * @returns {Promise<string[]>}
 */
export async function npmProjectProblems(root) {
  const separate = await separateNpmProjectsIn(root);
  const wanted = NPM_PROJECT_SETTINGS.map((key) => `${key}=true`);
  /** @type {string[]} */
  const problems = [];
  for (const dir of [".", ...separate]) {
    const npmrc = dir === "." ? ".npmrc" : `${dir}/.npmrc`;
    /** @type {string} */
    let text;
    try {
      text = await readFile(join(root, npmrc), "utf8");
    } catch (err) {
      if (!isMissing(err)) throw err;
      const where = dir === "." ? "the checkout" : dir;
      problems.push(
        `${npmrc} is missing: npm reads only the .npmrc of the project it runs in, so ${where} needs its own, with ${wanted.join(" and ")}`,
      );
      continue;
    }
    const settings = npmrcSettings(text);
    const unset = NPM_PROJECT_SETTINGS.filter((key) => settings.get(key) !== "true");
    if (unset.length > 0) problems.push(`${npmrc} does not set ${unset.map((key) => `${key}=true`).join(" or ")}`);
  }
  for (const dir of separate) {
    if (!OTHER_LOCKFILE_DIRS.includes(dir)) {
      problems.push(
        `${dir} is an npm project of its own whose lockfile this lint does not read: add it to OTHER_LOCKFILE_DIRS (scripts/lib/install-scripts.mjs)`,
      );
    }
    if (!(await exists(join(root, dir, "package-lock.json")))) {
      problems.push(`${dir} has no package-lock.json: every install there must be pinned`);
    }
  }
  return problems;
}
