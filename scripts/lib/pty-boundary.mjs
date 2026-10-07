/**
 * The PTY package stays out of the offline suite (docs/IMPLEMENTATION.md §17.1): `npm test` opens no PTY. From slice
 * 1c the terminal daemon owns the package (D88), and three rules keep the offline suite from ever loading it:
 *
 * 1. Only the live suites (`test/live/`, `packages/*\/test/live/`) and the daemon's PTY adapter
 *    (`packages/ptyd/src/node-pty-spawner.ts`) import `node-pty`, `@lydell/node-pty`, or one of its platform packages.
 * 2. Only the daemon's entry (`packages/ptyd/src/main.ts`) and the live suites import the PTY adapter.
 * 3. The daemon's entry is reached only by a dynamic `import()` from the CLI (`packages/cli/src/`), which only the
 *    `ptyd` command evaluates, or from the live suites; never statically, and never from an offline test or a script.
 *
 * The check walks the TypeScript syntax tree, so comments and strings never count.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import ts from "typescript";

/** @typedef {{ file: string; line: number }} PtyImport */
/** @typedef {{ specifier: string; line: number; dynamic: boolean }} ModuleReference */

/** The one file outside the live suites that imports the PTY package. */
export const PTY_ADAPTER = "packages/ptyd/src/node-pty-spawner.ts";
/** The daemon's process entry, the one file that imports the PTY adapter. */
export const DAEMON_ENTRY = "packages/ptyd/src/main.ts";

const PTY_PACKAGE = /^(?:node-pty|@lydell\/node-pty(?:-[a-z0-9-]+)?)(?:\/|$)/;
const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;
const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "test-results", "coverage"]);

/** The workspace package specifiers that name the two files. */
const PACKAGE_SPECIFIERS = new Map([
  ["@desk/ptyd/main", DAEMON_ENTRY],
  ["@desk/ptyd/node-pty-spawner", PTY_ADAPTER],
]);

/** @param {string} file */
function scriptKind(file) {
  if (/\.[cm]?jsx?$/.test(file)) return ts.ScriptKind.JS;
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

/**
 * The modules `text` refers to: import and export declarations, `import x = require(…)`, import types, `import(…)`
 * (dynamic) and `require(…)`, each with a literal module name.
 * @param {string} text
 * @param {string} file
 * @returns {ModuleReference[]}
 */
export function moduleReferences(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  /** @type {ModuleReference[]} */
  const found = [];
  /** @param {ts.Node} node @param {ts.Node | undefined} specifier @param {boolean} dynamic */
  const add = (node, specifier, dynamic) => {
    if (specifier !== undefined && ts.isStringLiteralLike(specifier)) {
      found.push({ specifier: specifier.text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, dynamic });
    }
  };
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node, node.moduleSpecifier, false);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression, false);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node, node.argument.literal, false);
    else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments[0], true);
      else if (ts.isIdentifier(callee) && callee.text === "require") add(node, node.arguments[0], false);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * The lines of `text` that import the PTY package.
 * @param {string} text
 * @param {string} file
 * @returns {number[]}
 */
export function ptyImportLines(text, file) {
  return moduleReferences(text, file)
    .filter((reference) => PTY_PACKAGE.test(reference.specifier))
    .map((reference) => reference.line);
}

/**
 * The repo path a specifier names, when it is relative or one of the daemon's package specifiers; else `null`.
 * @param {string} specifier
 * @param {string} from the importing file, relative and `/`-separated
 */
function resolved(specifier, from) {
  const named = PACKAGE_SPECIFIERS.get(specifier);
  if (named !== undefined) return named;
  if (!specifier.startsWith(".")) return null;
  return posix.normalize(posix.join(posix.dirname(from), specifier));
}

/**
 * Whether `path` (relative, `/`-separated) is inside a live suite: `test/live/…` or `packages/<name>/test/live/…`.
 * @param {string} path
 */
function inLiveSuite(path) {
  return /^test\/live\//.test(path) || /^packages\/[^/]+\/test\/live\//.test(path);
}

/**
 * Whether `file`'s reference keeps to the three rules above.
 * @param {string} file
 * @param {ModuleReference} reference
 */
function allowed(file, reference) {
  if (inLiveSuite(file)) return true;
  if (PTY_PACKAGE.test(reference.specifier)) return file === PTY_ADAPTER;
  const target = resolved(reference.specifier, file);
  if (target === PTY_ADAPTER) return file === DAEMON_ENTRY;
  if (target === DAEMON_ENTRY) return reference.dynamic && file.startsWith("packages/cli/src/");
  return true;
}

/**
 * Every reference that breaks the boundary, in the repo's root files, packages/, test/ and scripts/.
 * @param {string} root
 * @returns {Promise<PtyImport[]>}
 */
export async function ptyImportViolations(root) {
  /** @type {PtyImport[]} */
  const found = [];
  /** @param {string} relative @param {boolean} recurse */
  const walk = async (relative, recurse) => {
    let entries;
    try {
      entries = await readdir(join(root, relative), { withFileTypes: true });
    } catch (err) {
      if (/** @type {{ code?: string }} */ (err).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (recurse && !SKIPPED_DIRS.has(entry.name)) await walk(path, true);
      } else if (entry.isFile() && SOURCE.test(entry.name)) {
        for (const reference of moduleReferences(await readFile(join(root, path), "utf8"), path)) {
          if (!allowed(path, reference)) found.push({ file: path, line: reference.line });
        }
      }
    }
  };
  await walk("", false);
  for (const dir of ["packages", "test", "scripts"]) await walk(dir, true);
  return found;
}
