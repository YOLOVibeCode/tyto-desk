/**
 * The PTY package stays out of the offline suite (docs/IMPLEMENTATION.md §17.1): `npm test` opens no PTY, so no file
 * outside the live suites (`test/live/` and `packages/*\/test/live/`) imports `node-pty`, `@lydell/node-pty`, or one of
 * its platform packages. The check walks the TypeScript syntax tree, so comments and strings never count. Slice 2a's
 * daemon adapter is where the package will first be imported outside the live suites, with a check that the offline
 * suite never reaches it.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

/** @typedef {{ file: string; line: number }} PtyImport */

const PTY_PACKAGE = /^(?:node-pty|@lydell\/node-pty(?:-[a-z0-9-]+)?)(?:\/|$)/;
const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;
const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "test-results", "coverage"]);

/** @param {string} file */
function scriptKind(file) {
  if (/\.[cm]?jsx?$/.test(file)) return ts.ScriptKind.JS;
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

/**
 * The lines of `text` that import the PTY package: import and export declarations, `import x = require(…)`, import
 * types, `import(…)`, and `require(…)` with a literal module name.
 * @param {string} text
 * @param {string} file
 * @returns {number[]}
 */
export function ptyImportLines(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  /** @type {number[]} */
  const lines = [];
  /** @param {ts.Node} node @param {ts.Node | undefined} specifier */
  const check = (node, specifier) => {
    if (specifier !== undefined && ts.isStringLiteralLike(specifier) && PTY_PACKAGE.test(specifier.text)) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
  };
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) check(node, node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      check(node, node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) check(node, node.argument.literal);
    else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if (isImport || isRequire) check(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

/**
 * Whether `path` (relative, `/`-separated) is inside a live suite: `test/live/…` or `packages/<name>/test/live/…`.
 * @param {string} path
 */
function inLiveSuite(path) {
  return /^test\/live\//.test(path) || /^packages\/[^/]+\/test\/live\//.test(path);
}

/**
 * Every import of the PTY package outside the live suites, in the repo's root files, packages/, test/ and scripts/.
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
      } else if (entry.isFile() && SOURCE.test(entry.name) && !inLiveSuite(path)) {
        for (const line of ptyImportLines(await readFile(join(root, path), "utf8"), path)) found.push({ file: path, line });
      }
    }
  };
  await walk("", false);
  for (const dir of ["packages", "test", "scripts"]) await walk(dir, true);
  return found;
}
