/**
 * The bundles Desk ships, built with esbuild. Slice 1a bundles @desk/core as the extension will consume it: ESM for
 * a neutral platform, nothing external. The extension and the installed runtime join here in later slices.
 */
import { join, relative } from "node:path";
import { build } from "esbuild";

/** @typedef {{ path: string; text: string }} Bundle */

/**
 * @param {string} root the checkout
 * @returns {Promise<Bundle[]>} sorted by path, relative to dist/
 */
export async function buildBundles(root) {
  const src = join(root, "packages", "core", "src");
  const outdir = join(root, "dist");
  const result = await build({
    entryPoints: { "core/index": join(src, "index.ts"), "core/testing/index": join(src, "testing", "index.ts") },
    bundle: true,
    platform: "neutral",
    format: "esm",
    target: "es2023",
    write: false,
    outdir,
    logLevel: "silent",
  });
  return result.outputFiles
    .map((file) => ({ path: relative(outdir, file.path), text: file.text }))
    .sort((a, b) => a.path.localeCompare(b.path));
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
