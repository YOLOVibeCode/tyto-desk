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

/**
 * Node's own test (`isPipeName` in lib/net.js): a positional string is a socket path only when `Number()` does not
 * turn it into a port, so `"9583"`, `" 9583 "` and `""` are ports, which bind every interface without a host.
 * @param {string} text
 */
function isPipeName(text) {
  return !(Number(text) >= 0);
}

/**
 * A string on every path the checker can see: no `undefined`, `null` or `any` in it. Needs `strictNullChecks`.
 * @param {ts.Type} type
 * @returns {boolean}
 */
function isDefinitelyString(type) {
  if (type.isUnion()) return type.types.every(isDefinitelyString);
  if (type.isIntersection()) return type.types.some(isDefinitelyString);
  return (type.flags & ts.TypeFlags.StringLike) !== 0;
}

/**
 * `listen({ … })`: a literal `host: "127.0.0.1"`, or a `path` that is always a string and no `port` (Node prefers the
 * port to the path, and binds every interface when a port comes without a host). A spread, a method, an accessor or a
 * computed key could set any of them out of sight, so each one fails the check.
 * @param {ts.ObjectLiteralExpression} options
 * @param {ts.TypeChecker} checker
 */
function optionsNameLoopbackOrPath(options, checker) {
  /** @type {string | null} */
  let host = null;
  let hasPort = false;
  /** @type {ts.Node | null} */
  let path = null;
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return false;
    const key = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : null;
    if (key === null) return false;
    if (key === "host") {
      host = ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer) ? property.initializer.text : "";
    } else if (key === "port") {
      hasPort = true;
    } else if (key === "path") {
      path = ts.isPropertyAssignment(property) ? property.initializer : property.name;
    }
  }
  if (host === LOOPBACK) return true;
  return path !== null && !hasPort && isDefinitelyString(checker.getTypeAtLocation(path));
}

/**
 * Whether a Node `listen()` call binds 127.0.0.1 or a socket path: options as above; a positional string literal
 * that Node reads as a path; or a port whose host, the second argument, is the literal `"127.0.0.1"`. A positional
 * string that is not a literal could hold a number, which Node would read as a port on every interface.
 * @param {ts.CallExpression} call
 * @param {ts.TypeChecker} checker
 */
function namesLoopbackOrPath(call, checker) {
  const [first, second] = call.arguments;
  if (first === undefined) return false;
  if (ts.isObjectLiteralExpression(first)) return optionsNameLoopbackOrPath(first, checker);
  if (ts.isStringLiteralLike(first) && isPipeName(first.text)) return true;
  return second !== undefined && ts.isStringLiteralLike(second) && second.text === LOOPBACK;
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
    strictNullChecks: true,
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
