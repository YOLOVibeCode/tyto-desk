/**
 * The bundles Desk ships, built with esbuild (docs/IMPLEMENTATION.md §2, §15.1): @desk/core for a neutral platform (the
 * check that it runs inside Chrome), the extension's service worker and panel for Chrome, and the installed runtime's
 * `desk.mjs` with its chunks for Node. The PTY package stays external: the runtime build copies it beside desk.mjs.
 * Nothing here writes a file; `npm run build` checks the bundles and `npm run pack` writes them.
 */
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, relative } from "node:path";
import { build } from "esbuild";
import { extensionIdFromKey } from "../../packages/core/src/index.ts";

/** @typedef {{ path: string; text: string }} Bundle */
/** @typedef {import("esbuild").Metafile} Metafile */
/** @typedef {{ name: string; metafile: Metafile }} NamedMetafile */
/** @typedef {{ bundles: Bundle[]; metafiles: NamedMetafile[] }} BuildOutput */
/** @typedef {{ bundle: string; importer: string; bundled: string; declaredIn: "devDependencies" | "nothing" }} UndeclaredPackage */

/** Native code the runtime build copies beside desk.mjs instead of bundling (§2, D71). */
export const RUNTIME_EXTERNALS = ["@lydell/node-pty"];

/**
 * Optional packages a bundled dependency requires inside a `try` and runs without: esbuild leaves those requires
 * unresolved, and at run time they fail into the dependency's fallback. ws (the guarded endpoint) tries its native
 * helpers `bufferutil` and `utf-8-validate`, which are only its devDependencies, and masks and validates in JavaScript
 * without them. Mapping them to empty modules would break ws, which calls their functions once the require succeeds.
 */
export const OPTIONAL_TRIED_PACKAGES = /** @type {Readonly<Record<string, readonly string[]>>} */ ({ ws: ["bufferutil", "utf-8-validate"] });

/** The strict policy §9 gives every extension page. */
export const EXTENSION_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

const NODE_BUILTINS = new Set(builtinModules);

/**
 * @param {string} outdir
 * @param {import("esbuild").OutputFile[]} files
 * @param {string} prefix
 * @returns {Bundle[]}
 */
function bundlesOf(outdir, files, prefix) {
  return files.map((file) => ({ path: `${prefix}/${relative(outdir, file.path)}`, text: file.text }));
}

/**
 * Every bundle Desk ships, sorted by path relative to dist/, with esbuild's metafiles for the dependency check.
 * `testHooks` builds the live suite's test build, which exposes `globalThis.deskTest` (§17.3); production never does.
 * @param {string} root the checkout
 * @param {{ testHooks?: boolean }} [options]
 * @returns {Promise<BuildOutput>}
 */
export async function buildBundles(root, options = {}) {
  const dist = join(root, "dist");
  const core = join(root, "packages", "core", "src");
  const extension = join(root, "packages", "extension", "src");
  const shared = { bundle: true, write: false, logLevel: /** @type {const} */ ("silent"), absWorkingDir: root, metafile: true };

  const coreBuild = await build({
    ...shared,
    entryPoints: { "core/index": join(core, "index.ts"), "core/testing/index": join(core, "testing", "index.ts") },
    platform: "neutral",
    format: "esm",
    target: "es2023",
    outdir: dist,
  });
  const extensionBuild = await build({
    ...shared,
    entryPoints: { sw: join(extension, "sw.ts"), panel: join(extension, "panel.ts") },
    platform: "browser",
    format: "iife",
    target: "chrome155",
    define: { DESK_TEST: options.testHooks === true ? "true" : "false" },
    minifySyntax: true,
    outdir: join(dist, "extension"),
  });
  const runtimeBuild = await build({
    ...shared,
    entryPoints: { desk: join(root, "packages", "cli", "src", "desk.ts") },
    platform: "node",
    format: "esm",
    target: "node22.22",
    splitting: true,
    chunkNames: "chunks/[name]-[hash]",
    outExtension: { ".js": ".mjs" },
    external: RUNTIME_EXTERNALS,
    outdir: join(dist, "runtime"),
  });
  const outputs = (/** @type {import("esbuild").BuildResult} */ result) => {
    if (result.outputFiles === undefined || result.metafile === undefined) throw new Error("esbuild returned no output");
    return { files: result.outputFiles, metafile: result.metafile };
  };
  const coreOut = outputs(coreBuild);
  const extensionOut = outputs(extensionBuild);
  const runtimeOut = outputs(runtimeBuild);
  const bundles = [
    ...bundlesOf(dist, coreOut.files, "."),
    ...bundlesOf(join(dist, "extension"), extensionOut.files, "extension"),
    ...bundlesOf(join(dist, "runtime"), runtimeOut.files, "runtime"),
  ]
    .map((bundle) => ({ ...bundle, path: bundle.path.replace(/^\.\//, "") }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    bundles,
    metafiles: [
      { name: "extension", metafile: extensionOut.metafile },
      { name: "runtime", metafile: runtimeOut.metafile },
    ],
  };
}

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Forbidden Chrome switches spelled as arguments (`--name` or `-name`, any value) in a bundle, the value-specific ones
 * (`--name=…value…` in a comma-separated list), and `--remote-debugging-port=0`. Core keeps its lists without dashes,
 * so the lists themselves never match.
 * @param {Bundle[]} bundles
 * @param {readonly string[]} names
 * @param {readonly { name: string; values: readonly string[] }[]} [valued]
 * @returns {{ path: string; flag: string }[]}
 */
export function spelledForbiddenSwitches(bundles, names, valued = []) {
  /** @type {{ path: string; flag: string }[]} */
  const found = [];
  for (const bundle of bundles) {
    for (const name of names) {
      if (new RegExp(`(?<![A-Za-z0-9-])--?${escapeRegExp(name)}(?![A-Za-z0-9-])`, "i").test(bundle.text)) {
        found.push({ path: bundle.path, flag: `--${name}` });
      }
    }
    for (const { name, values } of valued) {
      for (const value of values) {
        const spelling = `(?<![A-Za-z0-9-])--?${escapeRegExp(name)}=[^\\s"'\`]*?(?<![A-Za-z0-9-])${escapeRegExp(value)}(?![A-Za-z0-9-])`;
        if (new RegExp(spelling, "i").test(bundle.text)) found.push({ path: bundle.path, flag: `--${name}=${value}` });
      }
    }
    if (/--remote-debugging-port=0(?![0-9])/.test(bundle.text)) {
      found.push({ path: bundle.path, flag: "--remote-debugging-port=0" });
    }
  }
  return found;
}

/**
 * What is wrong with the extension's manifest template (§9, §18): its key must give the id the native host's manifest
 * allows; its pages keep the strict CSP; it declares `externally_connectable` empty (left out, every other extension
 * may connect) and no web-accessible resources.
 * @param {Record<string, unknown>} manifest
 * @param {string} hostId the id the host manifest allows (core's DESK_EXTENSION_ID)
 * @returns {string[]}
 */
export function extensionManifestProblems(manifest, hostId) {
  /** @type {string[]} */
  const problems = [];
  let id = null;
  try {
    id = typeof manifest.key === "string" ? extensionIdFromKey(manifest.key) : null;
  } catch {
    id = null;
  }
  if (id === null) problems.push("the manifest has no key that is strict base64");
  else if (id !== hostId) problems.push(`the manifest key gives ${id}, not the host manifest's ${hostId}`);
  const csp = /** @type {Record<string, unknown> | undefined} */ (manifest.content_security_policy);
  if (csp?.extension_pages !== EXTENSION_CSP) problems.push("the extension pages' content security policy is not §9's");
  const connectable = /** @type {Record<string, unknown> | undefined} */ (manifest.externally_connectable);
  const empty = (/** @type {unknown} */ value) => Array.isArray(value) && value.length === 0;
  if (connectable === undefined || !empty(connectable.ids) || !empty(connectable.matches)) {
    problems.push("externally_connectable must be declared, with no ids and no matches");
  }
  if ("web_accessible_resources" in manifest) problems.push("the extension has web-accessible resources");
  return problems;
}

/**
 * The package a file belongs to: the nearest package.json above it, by its directory and name.
 * @param {string} root
 * @param {string} file relative to root
 * @param {Map<string, { dir: string; manifest: Record<string, unknown> } | null>} cache
 * @param {Record<string, Record<string, unknown>> | undefined} manifests stand-ins for package.json files, by path
 */
async function owningPackage(root, file, cache, manifests) {
  for (let dir = dirname(file); dir !== "." && dir !== "/" && dir !== ""; dir = dirname(dir)) {
    const path = `${dir}/package.json`;
    if (!cache.has(path)) {
      let manifest = manifests?.[path] ?? null;
      if (manifest === null && manifests === undefined) {
        manifest = await readFile(join(root, path), "utf8").then(
          (text) => /** @type {Record<string, unknown>} */ (JSON.parse(text)),
          () => null,
        );
      }
      cache.set(path, manifest === null || typeof manifest.name !== "string" ? null : { dir, manifest });
    }
    const found = cache.get(path);
    if (found) return found;
  }
  return null;
}

/** The package name an external import names: `@scope/name` or `name`, or null for a Node builtin. @param {string} spec */
function externalPackage(spec) {
  if (spec.startsWith("node:") || NODE_BUILTINS.has(spec.split("/")[0] ?? "")) return null;
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec);
}

/**
 * The packages a workspace bundles (or, for the runtime's externals, loads) without listing them in its own
 * `dependencies` (§15.1, §23.7): read from esbuild's metafiles, edge by edge, so a dev tool's update can never change
 * what ships. `manifests` stands in for package.json files in tests.
 * @param {string} root
 * @param {NamedMetafile[]} metafiles
 * @param {Record<string, Record<string, unknown>>} [manifests]
 * @returns {Promise<UndeclaredPackage[]>}
 */
export async function undeclaredBundledPackages(root, metafiles, manifests) {
  /** @type {Map<string, { dir: string; manifest: Record<string, unknown> } | null>} */
  const cache = new Map();
  /** @type {UndeclaredPackage[]} */
  const found = [];
  const seen = new Set();
  for (const { name, metafile } of metafiles) {
    for (const [input, info] of Object.entries(metafile.inputs)) {
      const importer = await owningPackage(root, input, cache, manifests);
      if (importer === null) continue;
      for (const edge of info.imports) {
        let bundled = null;
        if (edge.external === true) bundled = externalPackage(edge.path);
        else {
          const target = await owningPackage(root, edge.path, cache, manifests);
          bundled = target === null ? null : String(target.manifest.name);
        }
        const importerName = String(importer.manifest.name);
        if (bundled === null || bundled === importerName) continue;
        if (edge.external === true && OPTIONAL_TRIED_PACKAGES[importerName]?.includes(bundled) === true) continue;
        const dependencies = /** @type {Record<string, string> | undefined} */ (importer.manifest.dependencies) ?? {};
        if (Object.hasOwn(dependencies, bundled)) continue;
        const dev = /** @type {Record<string, string> | undefined} */ (importer.manifest.devDependencies) ?? {};
        const key = `${name}\0${importerName}\0${bundled}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ bundle: name, importer: importerName, bundled, declaredIn: Object.hasOwn(dev, bundled) ? "devDependencies" : "nothing" });
      }
    }
  }
  return found;
}
