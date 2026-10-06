/**
 * The @desk/core boundary (docs/IMPLEMENTATION.md §0): core source imports no Node builtin, no process, file, network,
 * PTY, terminal, browser-driver, Electron or LLM-SDK package, uses no Node global (Buffer, process, require, …), and no
 * Chrome extension API, so it runs unchanged inside the extension. Core tests run in Node and may use builtins, but
 * not those packages. The checks walk the TypeScript syntax tree, so comments and strings never count.
 */
import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

/** @typedef {"import" | "global"} Rule */
/** @typedef {{ file: string; line: number; rule: Rule; detail: string }} Violation */
/** @typedef {"src" | "test"} Scope */

const NODE_BUILTINS = new Set(builtinModules);

/** Packages core never imports, in source or tests. */
const PACKAGES = [
  /^ws$/,
  /^node-pty$/,
  /^@lydell\/node-pty/,
  /^@xterm\//,
  /^electron(?:\/|$)/,
  /^playwright/,
  /^@playwright\//,
  /^puppeteer/,
  /^chrome-remote-interface$/,
  /^@anthropic-ai\//,
  /^openai(?:\/|$)/,
  /litellm/i,
  /^@google\/(?:genai|generative-ai)/,
  /^undici$/,
  /^node-fetch$/,
];

/** Platform APIs core never touches: they are what adapters are for. */
const PLATFORM_GLOBALS = new Set(["WebSocket", "fetch", "XMLHttpRequest", "EventSource"]);

/** Node-only globals; core would not run in Chrome with them. */
const NODE_GLOBALS = new Set([
  "Buffer",
  "process",
  "require",
  "__dirname",
  "__filename",
  "global",
  "setImmediate",
  "clearImmediate",
]);

/** Top-level `chrome.*` extension namespaces. Config's own `chrome` section uses none of these names. */
const CHROME_APIS = new Set(
  (
    "accessibilityFeatures action alarms audio bookmarks browserAction browsingData certificateProvider commands " +
    "contentSettings contextMenus cookies debugger declarativeContent declarativeNetRequest desktopCapture devtools " +
    "documentScan dom downloads enterprise events extension extensionTypes fileBrowserHandler fileSystemProvider " +
    "fontSettings gcm history i18n identity idle input instanceID loginState management notifications offscreen " +
    "omnibox pageAction pageCapture permissions platformKeys power printerProvider printing printingMetrics privacy " +
    "processes proxy readingList runtime scripting search sessions settingsPrivate sidePanel storage system systemLog " +
    "tabCapture tabGroups tabs topSites tts ttsEngine types userScripts vpnProvider wallpaper " +
    "webAuthenticationProxy webNavigation webRequest windows"
  ).split(" "),
);

/** `globalThis.<name>` reaches these the long way round. */
const GLOBAL_THIS_IMPORT = new Set(["chrome", "browser", "WebSocket", "fetch", "XMLHttpRequest"]);

/** @param {string} spec */
function forbiddenModule(spec, /** @type {Scope} */ scope) {
  if (PACKAGES.some((pattern) => pattern.test(spec))) return true;
  if (scope === "test") return false;
  return spec.startsWith("node:") || NODE_BUILTINS.has(spec) || NODE_BUILTINS.has(spec.split("/")[0] ?? "");
}

/** Identifier positions that name something rather than refer to it. @param {ts.Identifier} node */
function isNamePosition(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  if (ts.isQualifiedName(parent)) return parent.right === node;
  if (ts.isBindingElement(parent)) return parent.propertyName === node;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;
  if (
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent) ||
    ts.isEnumMember(parent)
  ) {
    return parent.name === node;
  }
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return parent.label === node;
  return false;
}

/** @param {string} file */
function scriptKind(file) {
  if (/\.[cm]?jsx?$/.test(file)) return ts.ScriptKind.JS;
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

/**
 * Violations in one file's text. `detail` names the module or identifier only, never more of the source.
 * @param {string} text
 * @param {string} file
 * @param {Scope} [scope]
 * @returns {Violation[]}
 */
export function checkCoreSource(text, file, scope = "src") {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  /** @type {Violation[]} */
  const found = [];
  /** @param {ts.Node} node @param {Rule} rule @param {string} detail */
  const report = (node, rule, detail) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push({ file, line: line + 1, rule, detail });
  };
  /** @param {ts.Node} node @param {ts.Expression | undefined} specifier */
  const checkSpecifier = (node, specifier) => {
    if (specifier && ts.isStringLiteralLike(specifier) && forbiddenModule(specifier.text, scope)) {
      report(node, "import", `module "${specifier.text}"`);
    }
  };

  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) checkSpecifier(node, node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      checkSpecifier(node, node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      checkSpecifier(node, node.argument.literal);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments;
      if (specifier && ts.isStringLiteralLike(specifier)) checkSpecifier(node, specifier);
      else if (scope === "src") report(node, "import", "a computed dynamic import");
    } else if (scope === "src" && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      const target = node.expression;
      const member = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : null;
      if (ts.isIdentifier(target) && target.text === "globalThis") {
        if (member === null) report(node, "import", "globalThis[…]");
        else if (GLOBAL_THIS_IMPORT.has(member)) report(node, "import", `globalThis.${member}`);
        else if (NODE_GLOBALS.has(member)) report(node, "global", `globalThis.${member}`);
      }
      if (ts.isIdentifier(target) && target.text === "chrome" && (member === null || CHROME_APIS.has(member))) {
        report(node, "import", `chrome.${member ?? "[…]"}`);
      }
    } else if (scope === "src" && ts.isIdentifier(node) && !isNamePosition(node)) {
      if (NODE_GLOBALS.has(node.text)) report(node, "global", node.text);
      if (PLATFORM_GLOBALS.has(node.text)) report(node, "import", node.text);
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
    else if (/\.(?:[cm]?[jt]s|tsx)$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

/**
 * Every violation under `<coreDir>/src` (the full boundary) and `<coreDir>/test` (packages only).
 * @param {string} coreDir
 * @returns {Promise<Violation[]>}
 */
export async function coreBoundaryViolations(coreDir) {
  const root = resolve(coreDir);
  const repo = dirname(dirname(root));
  /** @type {Violation[]} */
  const violations = [];
  for (const scope of /** @type {const} */ (["src", "test"])) {
    for (const path of await sourceFiles(join(root, scope))) {
      violations.push(...checkCoreSource(await readFile(path, "utf8"), relative(repo, path), scope));
    }
  }
  return violations;
}
