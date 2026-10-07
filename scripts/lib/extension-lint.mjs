/**
 * lint:extension (docs/IMPLEMENTATION.md §9): the extension's own source never attaches the debugger (`debugger` is
 * granted only for `chrome.debugger.getTargets()`), never writes markup from strings (`innerHTML`, `outerHTML`,
 * `insertAdjacentHTML`, `document.write`), never builds code from strings (`eval`, `Function`), and imports nothing from
 * Node. It walks the TypeScript syntax tree, so comments and strings never count, and it reports file, line and rule,
 * never the source.
 */
import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join, relative } from "node:path";
import ts from "typescript";

/** @typedef {{ file: string; line: number; rule: string }} ExtensionViolation */

const MARKUP = new Set(["innerHTML", "outerHTML", "insertAdjacentHTML"]);
const DEBUGGER_METHODS = new Set(["attach", "sendCommand", "detach"]);
const NODE_BUILTINS = new Set(builtinModules);

/** @param {string} file */
function scriptKind(file) {
  if (/\.[cm]?jsx?$/.test(file)) return ts.ScriptKind.JS;
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

/** The member a property or element access names, when it is spelled out. @param {ts.Node} node */
function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
  return null;
}

/** Identifier positions that name something rather than refer to it. @param {ts.Identifier} node */
function isNamePosition(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  if (ts.isQualifiedName(parent)) return parent.right === node;
  if (
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isVariableDeclaration(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isParameter(parent)
  ) {
    return parent.name === node;
  }
  return ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent);
}

/** @param {string} specifier */
function isNodeModule(specifier) {
  return specifier.startsWith("node:") || NODE_BUILTINS.has(specifier) || NODE_BUILTINS.has(specifier.split("/")[0] ?? "");
}

/**
 * The rules `text` breaks, with their lines.
 * @param {string} text
 * @param {string} file
 * @returns {ExtensionViolation[]}
 */
export function checkExtensionSource(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  /** @type {ExtensionViolation[]} */
  const found = [];
  /** @param {ts.Node} node @param {string} rule */
  const report = (node, rule) => {
    found.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, rule });
  };
  /** @param {ts.Node} node @param {ts.Expression | undefined} specifier */
  const checkImport = (node, specifier) => {
    if (specifier !== undefined && ts.isStringLiteralLike(specifier) && isNodeModule(specifier.text)) report(node, "node: import");
  };
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) checkImport(node, node.moduleSpecifier);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) checkImport(node, node.arguments[0]);
    const member = memberName(node);
    if (member !== null && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      if (MARKUP.has(member)) report(node, member);
      if (DEBUGGER_METHODS.has(member) && memberName(node.expression) === "debugger") report(node, `chrome.debugger.${member}`);
      if ((member === "write" || member === "writeln") && ts.isIdentifier(node.expression) && node.expression.text === "document") {
        report(node, "document.write");
      }
    }
    if (ts.isIdentifier(node) && !isNamePosition(node)) {
      if (node.text === "eval") report(node, "eval");
      if (node.text === "Function") report(node, "Function(");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** @param {string} dir @returns {Promise<string[]>} */
async function sourceFiles(dir) {
  /** @type {string[]} */
  const files = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return files;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.(?:[cm]?[jt]s|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

/**
 * Every violation in the extension's own source, `<extensionDir>/src`.
 * @param {string} extensionDir
 * @returns {Promise<ExtensionViolation[]>}
 */
export async function extensionViolations(extensionDir) {
  /** @type {ExtensionViolation[]} */
  const found = [];
  for (const path of await sourceFiles(join(extensionDir, "src"))) {
    found.push(...checkExtensionSource(await readFile(path, "utf8"), relative(extensionDir, path)));
  }
  return found;
}
