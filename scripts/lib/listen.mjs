/**
 * Every Desk listener binds 127.0.0.1 or a Unix socket path (docs/IMPLEMENTATION.md §12): Node binds every interface
 * when the host is left out. The TypeScript checker resolves each `.listen()` call, so only Node's own
 * `Server.listen` is judged; a port's `listen(onConnection)` is someone else's method.
 */
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import ts from "typescript";

/** @typedef {{ file: string; line: number; detail: string }} ListenViolation */

const LOOPBACK = "127.0.0.1";

/** @param {string} dir @returns {Promise<string[]>} */
async function walk(dir) {
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
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (/\.(?:[cm]?[jt]s|tsx)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) files.push(path);
  }
  return files;
}

/** Every source file under `<root>/packages`, tests and stubs included. @param {string} root */
export async function packageSourceFiles(root) {
  return (await walk(join(resolve(root), "packages"))).sort();
}

/** @param {ts.Declaration | undefined} declaration */
function isNodeServerListen(declaration) {
  if (declaration === undefined) return true; // untyped (any): judge it like Node's
  return /[\\/]@types[\\/]node[\\/]/.test(declaration.getSourceFile().fileName);
}

/** @param {ts.CallExpression} call @param {ts.TypeChecker} checker */
function namesLoopbackOrPath(call, checker) {
  if (call.arguments.some((arg) => ts.isStringLiteralLike(arg) && arg.text === LOOPBACK)) return true;
  const [first] = call.arguments;
  if (first === undefined) return false;
  if (ts.isObjectLiteralExpression(first)) {
    return first.properties.some((property) => {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return false;
      const key = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : null;
      if (key === "path") return true;
      return (
        key === "host" &&
        ts.isPropertyAssignment(property) &&
        ts.isStringLiteralLike(property.initializer) &&
        property.initializer.text === LOOPBACK
      );
    });
  }
  // listen(path): a string that is not a number. Node reads a numeric string as a port on every interface.
  if (ts.isStringLiteralLike(first)) return !/^\d+$/.test(first.text);
  return (checker.getTypeAtLocation(first).flags & ts.TypeFlags.StringLike) !== 0;
}

/**
 * Calls to Node's `listen` in `files` that name neither 127.0.0.1 nor a socket path.
 * @param {string[]} files
 * @param {{ typeRoots: string[] }} options
 * @returns {ListenViolation[]}
 */
export function listenViolations(files, options) {
  const program = ts.createProgram(files, {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    allowImportingTsExtensions: true,
    types: ["node"],
    typeRoots: options.typeRoots,
  });
  const checker = program.getTypeChecker();
  const wanted = new Set(files.map((file) => resolve(file)));
  /** @type {ListenViolation[]} */
  const violations = [];
  for (const source of program.getSourceFiles()) {
    if (!wanted.has(resolve(source.fileName))) continue;
    /** @param {ts.Node} node */
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
            ? callee.argumentExpression.text
            : null;
        if (name === "listen") {
          const declaration = checker.getResolvedSignature(node)?.getDeclaration();
          if (isNodeServerListen(declaration) && !namesLoopbackOrPath(node, checker)) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
            violations.push({ file: source.fileName, line: line + 1, detail: "listen() without 127.0.0.1 or a socket path" });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}
