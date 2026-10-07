/**
 * The rules every workflow keeps (docs/IMPLEMENTATION.md §23.7). `lint:workflows` runs them on the checkout's
 * `.github/workflows/`, and `main`'s `pr-title` runs `main`'s copy on a pull request's workflow files, read through the
 * API as data. The YAML is parsed with `yaml`, never executed; shell in `run:` is tokenized, never run. A violation
 * names the file, the line and the rule, never more of the file.
 */
import { LineCounter, isAlias, isMap, isPair, isScalar, isSeq, parseDocument, visit } from "yaml";

/** @typedef {import("yaml").Document.Parsed} ParsedDocument */

/**
 * @typedef {"parse" | "yaml-alias" | "yaml-directive" | "yaml-tag" | "on-key" | "pinned-uses" | "local-action"
 *   | "top-permissions" | "job-permissions" | "timeout" | "persist-credentials" | "expression-in-run"
 *   | "pull-request-target" | "pr-title-trigger" | "forbidden-trigger" | "write-scope" | "ignore-scripts" | "cache"
 *   | "debug-output" | "secret-environment" | "publish-environment" | "call-concurrency" | "required-check-name"
 *   | "runner"} WorkflowRule
 */
/** @typedef {{ file: string; line: number | null; rule: WorkflowRule; detail: string }} WorkflowViolation */
/** @typedef {{ path: string; text: string }} WorkflowFile */
/** @typedef {{ repo: string; sha: string; tag: string; line: number | null }} ActionPin */

/** The workflows that may run on `pull_request_target`: they check out only the base and read the PR as data. */
export const PULL_REQUEST_TARGET_FILES = new Set(["pr-title.yml", "owner-merge.yml", "dependabot-auto-merge.yml"]);

/** Triggers that run privileged code on events anyone can cause. */
export const FORBIDDEN_TRIGGERS = new Set([
  "workflow_run",
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
  "repository_dispatch",
]);

/** The only runners: fixed labels, never `-latest`, whose image moves under the build. */
export const RUNNERS = new Set(["ubuntu-24.04", "ubuntu-24.04-arm", "macos-26"]);

/** Write scopes and the jobs (`file/job`) that may hold them. Every other write scope is refused. */
export const WRITE_SCOPES = new Map([
  ["id-token", new Set(["release.yml/publish", "edge.yml/attest"])],
  ["attestations", new Set(["release.yml/publish", "edge.yml/attest"])],
  ["contents", new Set(["release.yml/publish", "dependabot-auto-merge.yml/automerge"])],
  ["pull-requests", new Set(["owner-merge.yml/owner-merge", "dependabot-auto-merge.yml/automerge"])],
]);

/** Secrets and the environment that holds each (D52). `GITHUB_TOKEN` is the job's own token, not a stored secret. */
export const SECRET_ENVIRONMENTS = new Map([
  ["RELEASE_APP_PRIVATE_KEY", "release-please"],
  ["MACOS_CERTIFICATE", "signing"],
  ["MACOS_CERTIFICATE_PWD", "signing"],
  ["KEYCHAIN_PASSWORD", "signing"],
  ["NOTARIZATION_APPLE_ID", "signing"],
  ["NOTARIZATION_TEAM_ID", "signing"],
  ["NOTARIZATION_PASSWORD", "signing"],
]);

/** The required checks, and the one workflow each may come from. */
export const REQUIRED_CHECKS = new Map([
  ["ci-ok", "ci.yml"],
  ["pr-title", "pr-title.yml"],
]);

/** The workflow whose job is the `pr-title` check: it runs on `pull_request_target` alone, so `main`'s copy judges. */
const PR_TITLE_FILE = "pr-title.yml";

/** A local reusable workflow, which these rules read with every other file in `.github/workflows/`. */
const LOCAL_WORKFLOW = /^\.\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;

/** The `!!` handle's prefix in YAML 1.2; any other handle or prefix comes from a `%TAG` directive. */
const DEFAULT_TAG_PREFIX = "tag:yaml.org,2002:";

/** git's own options that take the next word as their value, before the subcommand. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source"]);

/**
 * git subcommands that bring commits or files onto the runner, or apply a diff or patches there (`git remote` only to
 * update or `add -f`).
 */
const GIT_BRINGS_CODE = new Set(["fetch", "fetch-pack", "checkout", "switch", "worktree", "clone", "pull", "restore", "apply", "am"]);

/** `gh api` options that take the next word as their value. */
const GH_API_VALUE_OPTIONS = new Set([
  "-H", "--header", "-X", "--method", "-f", "--raw-field", "-F", "--field", "--input", "-q", "--jq", "-t", "--template",
  "--hostname", "-p", "--preview", "--cache",
]);

/** `env` options that take the next word as their value. */
const ENV_VALUE_OPTIONS = new Set(["-u", "--unset", "-C", "--chdir", "-P"]);

/** Shells whose flags and `-c` scripts the rules read. */
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh"]);

/**
 * Variables a shell reads as it starts: SHELLOPTS turns set options on (xtrace among them), and BASH_ENV (bash) and ENV
 * (sh) name a file it runs first, which can turn tracing on.
 */
const SHELL_START_VARIABLES = new Set(["SHELLOPTS", "BASH_ENV", "ENV"]);

/**
 * A pull request's ref in any word: `refs/pull/…`, or `pull/<n>/head` and `pull/<n>/merge` as a word or a refspec's
 * side (`+pull/7/head:pr`). `pulls/<n>/files`, the REST API's, is no ref.
 */
const PULL_REF = /refs\/pull\/|(?:^|[\s:+"'=])pull\/[^\s/]+\/(?:head|merge)(?![\w-])/;

/** A download of a repository's code as an archive: the REST API's tarball and zipball, codeload, `/archive/`. */
const CODE_ARCHIVE = /\/(?:tarball|zipball)(?:[/?]|$)|codeload\.github\.com|github\.com\/\S*\/archive\//i;

/** A download of a file as it is at some commit: raw.githubusercontent.com (media. for LFS), or github.com's `/raw/`. */
const RAW_DOWNLOAD = /(?:raw|media)\.githubusercontent\.com|github\.com\/\S*(?:\/raw\/|[?&]raw=)/i;

/** Jobs whose output is attested or published: no cache may feed them, privileged or not. */
const NO_CACHE_JOBS = new Set(["pack", "attest", "publish"]);

/** Refs a `pull_request_target` checkout may name: the base, never the pull request. */
const BASE_REFS = new Set([
  "github.event.pull_request.base.sha",
  "github.event.pull_request.base.ref",
  "github.base_ref",
  "github.sha",
  "github.ref",
]);

/** npm commands that install packages, and so run install scripts unless told not to. */
const NPM_INSTALLS = new Set([
  "ci", "clean-install", "ic", "install-clean", "isntall-clean",
  "install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add",
  "install-test", "it", "install-ci-test", "cit",
  "update", "up", "upgrade", "udpate", "rebuild", "rb",
]);

/** npm options that take a value, so the value is not mistaken for the command. */
const NPM_VALUE_OPTIONS = new Set(["--prefix", "-C", "--workspace", "-w", "--userconfig", "--cache", "--registry", "--loglevel"]);

/** Words that run the command after them. */
const COMMAND_PREFIXES = new Set(["sudo", "exec", "time", "command", "builtin", "nohup", "nice"]);

/** @param {unknown} value @returns {Record<string, unknown> | null} */
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/** @param {string} path */
function baseName(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Splits shell into simple commands (arrays of words), honoring quotes, escapes, comments and line continuations, and
 * opening command substitutions. An approximation for the lint, which never runs anything.
 * @param {string} script
 * @returns {string[][]}
 */
export function shellCommands(script) {
  /** @type {string[][]} */
  const commands = [];
  /** @type {string[]} */
  let words = [];
  let word = "";
  let inWord = false;
  /** @type {string | null} */
  let quote = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < script.length; i += 1) {
    const c = script.charAt(i);
    const next = script.charAt(i + 1);
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && next !== "") {
        word += next;
        i += 1;
      } else word += c;
      continue;
    }
    if (c === "\\") {
      if (next === "\n") i += 1;
      else if (next !== "") {
        word += next;
        inWord = true;
        i += 1;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "$" && next === "{") {
      const close = script.indexOf("}", i);
      const end = close === -1 ? script.length : close + 1;
      word += script.slice(i, end);
      inWord = true;
      i = end - 1;
    } else if (c === "#" && !inWord) {
      while (i + 1 < script.length && script.charAt(i + 1) !== "\n") i += 1;
    } else if ("\n;&|()`{}".includes(c)) {
      endCommand();
    } else if (c === "<" || c === ">") {
      endWord();
      if (next === "&") i += 1;
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

/** The command a simple command runs, past `sudo`, `time` and the like, and variable assignments. @param {string[]} words */
function commandWords(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i] ?? "";
    if (COMMAND_PREFIXES.has(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i += 1;
    else break;
  }
  return words.slice(i);
}

/**
 * Whether npm's arguments turn install scripts off and nothing turns them back on. npm reads `--ignore-scripts false`,
 * `--ignore-scripts=false`, `--no-ignore-scripts`, other spellings and abbreviations (`--no-ignore`), and the last one
 * wins; after `--` nothing is an option. So only a plain `--ignore-scripts` (or `--ignore-scripts=true`, or
 * `--ignore-scripts true`) counts, and any other option that mentions ignore counts against.
 * @param {string[]} args the words after `npm`
 */
function ignoresScripts(args) {
  let ignored = false;
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i] ?? "";
    if (w === "--") break;
    if (w === "--ignore-scripts=true") {
      ignored = true;
    } else if (w === "--ignore-scripts") {
      const next = args[i + 1];
      if (next === "false") return false;
      if (next === "true") i += 1;
      ignored = true;
    } else if (w.startsWith("-") && /ignore/i.test(w)) {
      return false;
    }
  }
  return ignored;
}

/** Whether a simple command installs with npm without `--ignore-scripts`. @param {string[]} words */
function npmInstallWithScripts(words) {
  const at = words.findIndex((w) => w === "npm" || w.endsWith("/npm"));
  if (at === -1) return false;
  const rest = words.slice(at + 1);
  let subcommand = null;
  for (let i = 0; i < rest.length; i += 1) {
    const w = rest[i] ?? "";
    if (NPM_VALUE_OPTIONS.has(w)) {
      i += 1;
    } else if (!w.startsWith("-")) {
      subcommand = w;
      break;
    }
  }
  if (subcommand === null || !NPM_INSTALLS.has(subcommand)) return false;
  return !ignoresScripts(rest);
}

/** How many `-c`, `eval` or `env` scripts deep the rules read a command. */
const MAX_SCRIPT_DEPTH = 3;

/** An option name as bash and zsh compare it: zsh ignores case and underscores (`XTRACE`, `x_trace`). @param {string | undefined} name */
function optionName(name) {
  return (name ?? "").toLowerCase().replace(/_/g, "");
}

/**
 * Whether a shell's or `set`'s arguments turn tracing on: a flag cluster with `x` (`-x`, `-ex`, `-eox`), `-o xtrace`
 * (also at the end of a cluster, `-eo xtrace`, and as zsh spells it, `-o XTRACE`), or zsh's `--xtrace`. With `plus`,
 * as `set` is read, a `+` cluster counts too, though `set +x` turns tracing off.
 * @param {readonly string[]} args
 * @param {{ plus?: boolean }} [options]
 */
function traceFlags(args, { plus = false } = {}) {
  const sign = plus ? "[-+]" : "-";
  const cluster = new RegExp(`^${sign}[a-zA-Z]*x[a-zA-Z]*$`);
  const option = new RegExp(`^${sign}[a-zA-Z]*o$`);
  return args.some((w, i) => cluster.test(w) || optionName(w) === "--xtrace" || (option.test(w) && optionName(args[i + 1]) === "xtrace"));
}

/**
 * Whether a SHELLOPTS value turns tracing on (bash reads it from the environment at start), or may: one built from a
 * variable or an expression, which the rules cannot read.
 * @param {unknown} value
 */
function tracingShellOptions(value) {
  return typeof value === "string" && (/[$`]/.test(value) || value.split(":").some((name) => optionName(name) === "xtrace"));
}

/**
 * Whether a word sets a variable that makes a shell trace, or run a file, as it starts: SHELLOPTS that traces
 * (tracingShellOptions), or BASH_ENV or ENV with any value, as `NAME=value` or as `NAME<<EOF`, the multiline form of a
 * `$GITHUB_ENV` line. Any word counts, so an assignment before a command, `export`, `env` and
 * `echo "…" >> "$GITHUB_ENV"` all do.
 * @param {string} word
 */
function tracingAssignment(word) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(=|<<)([\s\S]*)$/.exec(word);
  if (match === null || !SHELL_START_VARIABLES.has(match[1] ?? "")) return false;
  return match[1] !== "SHELLOPTS" || match[2] === "<<" || tracingShellOptions(match[3]);
}

/**
 * Whether an `env:` mapping (a workflow's, a job's or a step's) sets SHELLOPTS that traces, BASH_ENV or ENV
 * (tracingAssignment), or is an expression the rules cannot read.
 * @param {unknown} env
 */
function tracingEnvironment(env) {
  if (typeof env === "string") return true;
  const record = asRecord(env);
  if (record === null) return false;
  return Object.entries(record).some(([name, value]) => SHELL_START_VARIABLES.has(name) && (name !== "SHELLOPTS" || tracingShellOptions(value)));
}

/**
 * The command `env` runs, past its options and assignments, or null when it runs none and so prints the environment.
 * `-S` (`--split-string`) splits its value into words that stand in its place, as in `env -S "bash -x" {0}`.
 * @param {readonly string[]} args the words after `env`
 * @returns {string[] | null}
 */
function envCommand(args) {
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i] ?? "";
    /** @type {{ value: string; next: number } | null} */
    let split = null;
    if (w === "-S" || w === "--split-string") split = { value: args[i + 1] ?? "", next: i + 2 };
    else if (/^-S./.test(w)) split = { value: w.slice(2), next: i + 1 };
    else if (w.startsWith("--split-string=")) split = { value: w.slice("--split-string=".length), next: i + 1 };
    if (split !== null) return envCommand([...shellCommands(split.value).flat(), ...args.slice(split.next)]);
    if (w === "--") {
      const rest = args.slice(i + 1);
      const at = rest.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
      return at === -1 ? null : rest.slice(at);
    }
    if (ENV_VALUE_OPTIONS.has(w)) i += 1;
    else if (!w.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) return args.slice(i);
  }
  return null;
}

/**
 * Whether a simple command prints the environment or turns tracing on: `env` with no command, `printenv`, `export -p`,
 * `declare -p` or `-x`, `compgen -e` or `-v`; `set` with a tracing flag (traceFlags), `shopt` with xtrace, zsh's
 * `setopt` or `unsetopt` naming xtrace; a shell (`bash`, `sh`, `zsh`, `dash`, `ksh`, `mksh`, by name or by path)
 * wherever it sits in the command (`env … bash`, `xargs bash`, `sudo -E bash`) with a tracing flag, or whose `-c`
 * script does any of this, as `eval`'s script and the command `env` runs (`env -S` included) may; and any word that
 * sets SHELLOPTS that traces, BASH_ENV or ENV (tracingAssignment).
 * @param {string[]} words
 * @param {number} [depth] how many `-c`, `eval` or `env` scripts deep this command is
 * @returns {boolean}
 */
function printsEnvironment(words, depth = 0) {
  if (words.some(tracingAssignment)) return true;
  const [name, ...args] = commandWords(words);
  if (name === undefined) return false;
  const reads = (/** @type {string[]} */ command) => depth < MAX_SCRIPT_DEPTH && printsEnvironment(command, depth + 1);
  const script = (/** @type {string} */ text) => shellCommands(text).some(reads);
  switch (baseName(name)) {
    case "env": {
      const command = envCommand(args);
      return command === null || reads(command);
    }
    case "printenv":
      return true;
    case "set":
      return traceFlags(args, { plus: true });
    case "shopt":
      return args.some((w) => optionName(w) === "xtrace");
    case "setopt":
    case "unsetopt":
      return args.some((w) => optionName(w).includes("xtrace"));
    case "export":
      return args.includes("-p");
    case "declare":
    case "typeset":
      return args.some((w) => /^-[a-zA-Z]*[px][a-zA-Z]*$/.test(w));
    case "compgen":
      return args.includes("-e") || args.includes("-v");
    case "eval":
      return script(args.join(" "));
    default:
      break;
  }
  const shell = words.findIndex((w) => SHELLS.has(baseName(w)));
  if (shell === -1) return false;
  const shellArgs = words.slice(shell + 1);
  if (traceFlags(shellArgs)) return true;
  const flag = shellArgs.findIndex((w) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
  return flag !== -1 && script(shellArgs[flag + 1] ?? "");
}

/**
 * Whether a `shell:` (a step's, or `defaults.run.shell`) traces its commands or prints the environment, read as one
 * command (printsEnvironment): a shell with a tracing flag or a `-c` script that traces (`bash -c "set -x; . {0}"`),
 * one `env` runs (`env -S "bash -x" {0}`), SHELLOPTS that traces, BASH_ENV or ENV set before it, or `env` or
 * `printenv` itself.
 * @param {unknown} spec
 */
function loudShell(spec) {
  return typeof spec === "string" && shellCommands(spec).some((words) => printsEnvironment(words));
}

/** Every string anywhere in `value`. @param {unknown} value @returns {string[]} */
function strings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  const record = asRecord(value);
  if (record === null) return [];
  return Object.entries(record).flatMap(([key, item]) => [key, ...strings(item)]);
}

/** `${{ expr }}` → `expr`, whitespace trimmed; `null` for any other text. @param {unknown} value */
function soleExpression(value) {
  if (typeof value !== "string") return null;
  const match = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(value.trim());
  return match?.[1] ?? null;
}

/** Stands for an expression that reaches every secret at once, such as `toJSON(secrets)`. */
const ALL_SECRETS = "*";

/**
 * The secrets `text` names. Only `${{ … }}` expressions can reach a secret, so only they count: `check-secrets.mjs` in a
 * script is a file name.
 * @param {string} text
 * @returns {string[]}
 */
function secretNames(text) {
  const names = [];
  for (const [, expression = ""] of text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    for (const match of expression.matchAll(/(?<![\w.-])secrets\b(?:\s*\.\s*([A-Za-z_][A-Za-z0-9_-]*)|\s*\[\s*['"]([^'"]+)['"]\s*\])?/g)) {
      names.push(match[1] ?? match[2] ?? ALL_SECRETS);
    }
  }
  return names;
}

/** @param {unknown} value @returns {string | null} */
function environmentName(value) {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return record !== null && typeof record.name === "string" ? record.name : null;
}

/** The trigger names of `on`, whatever its form. @param {unknown} on @returns {string[]} */
function triggers(on) {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.filter((item) => typeof item === "string");
  const record = asRecord(on);
  return record === null ? [] : Object.keys(record);
}

/**
 * The action a `uses:` names, without its ref and lowercased (`Actions/Checkout@…` → `actions/checkout`): GitHub
 * resolves an owner and a repository without case, so the rules compare that way.
 * @param {unknown} uses
 * @returns {string | null}
 */
function actionOf(uses) {
  if (typeof uses !== "string") return null;
  const at = uses.indexOf("@");
  return (at === -1 ? uses : uses.slice(0, at)).toLowerCase().replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

/** @param {unknown} uses */
function isCheckout(uses) {
  return actionOf(uses) === "actions/checkout";
}

/** @param {unknown} value */
function isFalse(value) {
  return value === false || value === "false";
}

/**
 * Line numbers for nodes of one parsed file: `at(["jobs", "build", "runs-on"])` is the line of the deepest key or item
 * on that path that exists.
 * @param {ParsedDocument} doc
 * @param {LineCounter} counter
 */
function locator(doc, counter) {
  /** @param {(string | number)[]} path @returns {number | null} */
  return (path) => {
    /** @type {unknown} */
    let node = doc.contents;
    let line = null;
    for (const segment of path) {
      if (isMap(node)) {
        const pair = node.items.find((item) => isScalar(item.key) && item.key.value === segment);
        if (pair === undefined) break;
        const key = /** @type {{ range?: [number, number, number] | null }} */ (pair.key);
        if (key.range) line = counter.linePos(key.range[0]).line;
        node = pair.value;
      } else if (isSeq(node) && typeof segment === "number") {
        const item = /** @type {{ range?: [number, number, number] | null } | undefined} */ (node.items[segment]);
        if (item?.range) line = counter.linePos(item.range[0]).line;
        node = item;
      } else break;
    }
    return line;
  };
}

/**
 * The pinned actions in one workflow: every `uses: owner/repo[/path]@<40-hex>` with the tag its trailing comment
 * names. Local paths are left out.
 * @param {string} text
 * @returns {ActionPin[]}
 */
export function actionPins(text) {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter, uniqueKeys: true });
  /** @type {ActionPin[]} */
  const pins = [];
  visit(doc, {
    Pair(_, pair) {
      if (!isPair(pair) || !isScalar(pair.key) || pair.key.value !== "uses" || !isScalar(pair.value)) return;
      const value = pair.value;
      const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/[^@]+)?@([0-9a-f]{40})$/.exec(String(value.value));
      const tag = (value.comment ?? "").trim();
      if (match === null || !/^[A-Za-z0-9][A-Za-z0-9._/+-]*$/.test(tag)) return;
      pins.push({
        repo: match[1] ?? "",
        sha: match[2] ?? "",
        tag,
        line: value.range ? counter.linePos(value.range[0]).line : null,
      });
    },
  });
  return pins;
}

/**
 * Every rule that concerns one file alone.
 * @param {WorkflowFile} file
 * @returns {{ violations: WorkflowViolation[]; checkNames: { name: string; line: number | null }[] }}
 */
function checkOne(file) {
  const name = baseName(file.path);
  /** @type {WorkflowViolation[]} */
  const violations = [];
  /** @type {{ name: string; line: number | null }[]} */
  const checkNames = [];
  const counter = new LineCounter();
  const doc = parseDocument(file.text, { lineCounter: counter, uniqueKeys: true });
  if (doc.errors.length > 0) {
    const error = doc.errors[0];
    const line = error?.linePos?.[0]?.line ?? null;
    violations.push({ file: file.path, line, rule: "parse", detail: "the file is not valid YAML" });
    return { violations, checkNames };
  }
  const at = locator(doc, counter);
  /** @param {(string | number)[]} path @param {WorkflowRule} rule @param {string} detail */
  const report = (path, rule, detail) => violations.push({ file: file.path, line: at(path), rule, detail });

  /** @param {string} uses @param {(string | number)[]} path */
  function checkPinned(uses, path) {
    const node = doc.getIn(path, true);
    const comment = isScalar(node) ? (node.comment ?? "").trim() : "";
    const pinned = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@]+)?@[0-9a-f]{40}$/.test(uses);
    if (!pinned || !/^[A-Za-z0-9][A-Za-z0-9._/+-]*$/.test(comment)) {
      report(path, "pinned-uses", "every action is pinned to a 40-character commit SHA with its tag in a comment");
    }
  }

  // A directive changes how plain values read: under `%YAML 1.1`, `on:` is the boolean true, and these rules would see
  // no trigger where GitHub sees one. The rules read YAML 1.2 only.
  const tags = Object.entries(doc.directives?.tags ?? {});
  if (doc.directives?.yaml.explicit === true || tags.some(([handle, prefix]) => handle !== "!!" || prefix !== DEFAULT_TAG_PREFIX)) {
    const index = file.text.split("\n").findIndex((line) => line.startsWith("%"));
    violations.push({
      file: file.path,
      line: index === -1 ? null : index + 1,
      rule: "yaml-directive",
      detail: "a %YAML or %TAG directive changes how values read; workflows are plain YAML 1.2",
    });
    return { violations, checkNames };
  }

  /** @type {WorkflowRule | null} */
  let hidden = null;
  visit(doc, (_, node) => {
    if (hidden !== null) return;
    const { anchor, tag, range } = /** @type {{ anchor?: unknown; tag?: unknown; range?: [number, number, number] | null }} */ (node);
    const line = range ? counter.linePos(range[0]).line : null;
    if (isAlias(node) || (typeof anchor === "string" && anchor !== "")) {
      hidden = "yaml-alias";
      violations.push({ file: file.path, line, rule: hidden, detail: "anchors and aliases hide what a job runs; spell every value out" });
    } else if (typeof tag === "string" && tag !== "") {
      hidden = "yaml-tag";
      violations.push({ file: file.path, line, rule: hidden, detail: "an explicit tag can make a value read differently; spell every value plainly" });
    }
  });
  if (hidden !== null) return { violations, checkNames };

  const workflow = asRecord(doc.toJS()) ?? {};
  const events = triggers(workflow.on);
  const pullRequestTarget = events.includes("pull_request_target");
  const reusable = events.includes("workflow_call");

  if (!Object.hasOwn(workflow, "on") || events.length === 0) {
    report(["on"], "on-key", "the workflow names its triggers under a plain on key");
  }
  for (const event of events) {
    if (FORBIDDEN_TRIGGERS.has(event)) report(["on", event], "forbidden-trigger", `the ${event} trigger is never used`);
  }
  if (pullRequestTarget && !PULL_REQUEST_TARGET_FILES.has(name)) {
    report(["on", "pull_request_target"], "pull-request-target", "pull_request_target runs only in pr-title.yml, owner-merge.yml and dependabot-auto-merge.yml");
  }
  if (name === PR_TITLE_FILE && (events.length !== 1 || events[0] !== "pull_request_target")) {
    report(["on"], "pr-title-trigger", "pr-title.yml runs on pull_request_target alone, so the pr-title check always comes from main's copy");
  }
  const top = asRecord(workflow.permissions);
  if (top === null || Object.keys(top).length > 0) {
    report(["permissions"], "top-permissions", "the workflow sets permissions: {} and each job asks for what it needs");
  }
  if (reusable && workflow.concurrency !== undefined) {
    report(["concurrency"], "call-concurrency", "a workflow_call workflow declares no concurrency; its caller does");
  }

  const workflowStrings = strings({ env: workflow.env, defaults: workflow.defaults });
  for (const secret of workflowStrings.flatMap(secretNames)) {
    if (secret !== "GITHUB_TOKEN") report(["env"], "secret-environment", `secrets.${secret} outside any job`);
  }

  const jobs = asRecord(workflow.jobs) ?? {};
  for (const [id, value] of Object.entries(jobs)) {
    const job = asRecord(value) ?? {};
    const where = ["jobs", id];
    // A job's check run is named after its id or its name, compared trimmed and without case. GitHub evaluates
    // expressions in a name, so a name with one counts when the literal text before it could still begin a required
    // check's name (`${{ matrix.n }}`, `ci-${{ 'ok' }}`); `check (Node ${{ matrix.node }})` cannot.
    /** @type {Set<string>} */
    const names = new Set();
    for (const raw of [id, ...(typeof job.name === "string" ? [job.name] : [])]) {
      const expression = raw.indexOf("${{");
      if (expression === -1) {
        names.add(raw.trim().toLowerCase());
        continue;
      }
      const prefix = raw.slice(0, expression).trim().toLowerCase();
      if ([...REQUIRED_CHECKS.keys()].some((check) => check.startsWith(prefix))) {
        report([...where, "name"], "required-check-name", `${id}'s name is an expression that could make it ci-ok or pr-title; begin it with other text`);
      }
    }
    for (const checkName of names) {
      if (REQUIRED_CHECKS.has(checkName)) checkNames.push({ name: checkName, line: at(where) });
    }

    // Permissions: a mapping of scopes; write scopes only where §23.7 gives them.
    const permissions = job.permissions;
    /** @type {string[]} */
    const writes = [];
    if (typeof permissions === "string") {
      if (permissions === "write-all") writes.push("write-all");
      else report([...where, "permissions"], "job-permissions", `${id} lists the scopes it needs instead of ${permissions}`);
    } else if (permissions !== undefined) {
      const scopes = asRecord(permissions);
      if (scopes === null) report([...where, "permissions"], "job-permissions", `${id}'s permissions are not a mapping`);
      for (const [scope, level] of Object.entries(scopes ?? {})) if (level === "write") writes.push(scope);
    }
    for (const scope of writes) {
      if (!WRITE_SCOPES.get(scope)?.has(`${name}/${id}`)) {
        report([...where, "permissions"], "write-scope", `${id} may not hold ${scope === "write-all" ? "write-all" : `${scope}: write`}`);
      }
    }

    // Secrets: only in the job of the environment that holds them.
    const environment = environmentName(job.environment);
    const jobStrings = strings(job);
    if (job.secrets === "inherit") report([...where, "secrets"], "secret-environment", `${id} passes every secret on`);
    const secrets = jobStrings.flatMap(secretNames).filter((secret) => secret !== "GITHUB_TOKEN");
    for (const secret of new Set(secrets)) {
      const holder = SECRET_ENVIRONMENTS.get(secret);
      if (secret === ALL_SECRETS) report(where, "secret-environment", `${id} reaches every secret at once`);
      else if (holder === undefined) report(where, "secret-environment", `no environment holds secrets.${secret}`);
      else if (holder !== environment) report(where, "secret-environment", `secrets.${secret} is used outside the ${holder} environment`);
    }
    if (id === "publish" && environment !== "publish") {
      report(where, "publish-environment", "the publish job runs in the publish environment");
    }
    if (reusable && job.concurrency !== undefined) {
      report([...where, "concurrency"], "call-concurrency", "a workflow_call workflow declares no concurrency; its caller does");
    }

    if (typeof job.uses === "string") {
      if (!job.uses.startsWith("./")) checkPinned(job.uses, [...where, "uses"]);
      else if (!LOCAL_WORKFLOW.test(job.uses)) {
        report([...where, "uses"], "local-action", "a job calls a reusable workflow in .github/workflows/, where these rules read it");
      }
      if (pullRequestTarget) {
        report([...where, "uses"], "pull-request-target", "a pull_request_target workflow calls no reusable workflow, which would run with its trust");
      }
      continue;
    }

    if (typeof job["runs-on"] !== "string" || !RUNNERS.has(job["runs-on"])) {
      report([...where, "runs-on"], "runner", "runners are ubuntu-24.04, ubuntu-24.04-arm or macos-26, never -latest");
    }
    if (job["timeout-minutes"] === undefined) report(where, "timeout", `${id} has no timeout-minutes`);

    // A job is privileged when it holds a secret, an environment (whose secrets and deployment rights reach it), the
    // App's token or a write scope (D84): no cache may feed it, and nothing in it may print the environment or trace.
    const privileged =
      writes.length > 0 ||
      secrets.length > 0 ||
      environment !== null ||
      (Array.isArray(job.steps) && job.steps.some((step) => actionOf(asRecord(step)?.uses) === "actions/create-github-app-token"));
    const noCache = pullRequestTarget || NO_CACHE_JOBS.has(id) || privileged;
    if (privileged && [...jobStrings, ...workflowStrings].some((text) => /ACTIONS_(?:STEP|RUNNER)_DEBUG/.test(text))) {
      report(where, "debug-output", `${id} holds a secret, an environment or a write scope and must not turn on debug logging`);
    }
    if (privileged) {
      if (loudShell(asRecord(asRecord(workflow.defaults)?.run)?.shell)) {
        report(["defaults", "run", "shell"], "debug-output", `${id} holds a secret, an environment or a write scope, and the workflow's default shell traces its commands`);
      }
      if (loudShell(asRecord(asRecord(job.defaults)?.run)?.shell)) {
        report([...where, "defaults", "run", "shell"], "debug-output", `${id} holds a secret, an environment or a write scope and must not trace its shell`);
      }
      if (tracingEnvironment(workflow.env)) {
        report(["env"], "debug-output", `${id} holds a secret, an environment or a write scope, and the workflow's env makes its shells trace (SHELLOPTS with xtrace, BASH_ENV or ENV)`);
      }
      if (tracingEnvironment(job.env)) {
        report([...where, "env"], "debug-output", `${id} holds a secret, an environment or a write scope and must not trace its shell (SHELLOPTS with xtrace, BASH_ENV or ENV)`);
      }
    }

    const steps = Array.isArray(job.steps) ? job.steps : [];
    steps.forEach((value, index) => {
      const step = asRecord(value) ?? {};
      const stepPath = [...where, "steps", index];
      const uses = typeof step.uses === "string" ? step.uses : null;
      const action = actionOf(uses);
      const withs = asRecord(step.with) ?? {};
      if (uses !== null && uses.startsWith("./")) {
        report([...stepPath, "uses"], "local-action", "steps use pinned actions only: a local action's own steps would escape these rules");
      } else if (uses !== null) checkPinned(uses, [...stepPath, "uses"]);
      if (isCheckout(uses)) {
        if (!isFalse(withs["persist-credentials"])) {
          report(stepPath, "persist-credentials", "every checkout sets persist-credentials: false");
        }
        if (pullRequestTarget) {
          const ref = withs.ref === undefined ? null : soleExpression(withs.ref);
          const repository = withs.repository === undefined ? null : soleExpression(withs.repository);
          if ((withs.ref !== undefined && (ref === null || !BASE_REFS.has(ref))) || (withs.repository !== undefined && repository !== "github.repository")) {
            report(stepPath, "pull-request-target", "a pull_request_target workflow checks out only the base");
          }
        }
      }
      if (noCache && action !== null) {
        if (/^actions\/cache(?:\/(?:restore|save))?$/.test(action)) {
          report(stepPath, "cache", `${id} may not restore or save a cache`);
        } else if (action === "actions/setup-node" && (withs.cache !== undefined || !isFalse(withs["package-manager-cache"]))) {
          report(stepPath, "cache", `${id} runs setup-node with package-manager-cache: false and no cache`);
        }
      }
      if (privileged && loudShell(step.shell)) {
        report([...stepPath, "shell"], "debug-output", `${id} holds a secret, an environment or a write scope and must not trace its shell`);
      }
      if (privileged && tracingEnvironment(step.env)) {
        report([...stepPath, "env"], "debug-output", `${id} holds a secret, an environment or a write scope and must not trace its shell (SHELLOPTS with xtrace, BASH_ENV or ENV)`);
      }
      const scripts = [
        ...(typeof step.run === "string" ? [{ text: step.run, key: "run" }] : []),
        ...(action === "actions/github-script" && typeof withs.script === "string" ? [{ text: withs.script, key: "with" }] : []),
      ];
      for (const { text, key } of scripts) {
        for (const match of text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
          if (!/^\s*(?:matrix|runner)\.[A-Za-z0-9_.-]+\s*$/.test(match[1] ?? "")) {
            report([...stepPath, key], "expression-in-run", "pass expressions to scripts through env; only matrix.* and runner.* may appear inline");
            break;
          }
        }
        if (key !== "run") continue;
        const commands = shellCommands(text);
        if (commands.some(npmInstallWithScripts)) {
          report([...stepPath, "run"], "ignore-scripts", "every npm ci or npm install passes --ignore-scripts itself");
        }
        if (privileged && commands.some((words) => printsEnvironment(words))) {
          report([...stepPath, "run"], "debug-output", `${id} holds a secret, an environment or a write scope and must not print its environment or trace its commands`);
        }
        if (pullRequestTarget && commands.some((words) => checksOutPullRequest(words))) {
          report(
            [...stepPath, "run"],
            "pull-request-target",
            "a pull_request_target workflow reads the pull request as data, through the base's scripts: no git fetch, clone, apply or am, no pull request ref, no gh repo clone, gh pr checkout or gh pr diff, no patch, no code archive or raw file download, no gh api path the rules cannot read",
          );
        }
      }
    });
  }
  return { violations, checkNames };
}

/**
 * Whether a `gh api` call's endpoint is one the rules cannot read: missing (handed over by `xargs` or a substitution),
 * built from a variable or a substitution (`$…`, a backtick), or cut short by one (it ends in `/` or `=`). Such a path
 * can name a tarball, a zipball or any file of the pull request where no rule sees it.
 * @param {readonly string[]} args the words after `gh api`
 */
function unreadableEndpoint(args) {
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i] ?? "";
    if (GH_API_VALUE_OPTIONS.has(w)) i += 1;
    else if (w === "--" || !w.startsWith("-")) {
      const endpoint = w === "--" ? args[i + 1] : w;
      return endpoint === undefined || /[$`]/.test(endpoint) || /[/=]$/.test(endpoint);
    }
  }
  return true;
}

/**
 * Commands that would bring the pull request's code onto the runner: git fetching anything or applying a diff or
 * patches (past git's own options, `git -C . fetch`, and wherever git sits in the command, `env … git`, `xargs git`;
 * `apply` and `am` included), `patch`, any word naming a pull request ref (`refs/pull/…`, `pull/<n>/head`), a download
 * of a code archive (`gh api …/tarball`, `/zipball`, codeload) or of a raw file (raw.githubusercontent.com, github.com's
 * `/raw/`), `gh pr checkout`, `gh pr diff`, `gh repo clone` and `gh repo fork --clone`, and `gh api` on a path the rules
 * cannot read (unreadableEndpoint), also inside `bash -c '…'`, `sh -c` or `eval`.
 * @param {string[]} words
 * @param {number} [depth] how many `-c` or `eval` scripts deep this command is
 * @returns {boolean}
 */
function checksOutPullRequest(words, depth = 0) {
  if (words.some((w) => PULL_REF.test(w) || CODE_ARCHIVE.test(w) || RAW_DOWNLOAD.test(w) || baseName(w) === "patch")) return true;
  // A script handed to a shell or eval, wherever it sits in the command (`env X=1 bash -c '…'`, `xargs sh -c '…'`).
  const shell = words.findIndex((w) => w === "eval" || SHELLS.has(baseName(w)));
  if (shell !== -1 && depth < MAX_SCRIPT_DEPTH) {
    const args = words.slice(shell + 1);
    /** @type {string | null} */
    let script = null;
    if (words[shell] === "eval") script = args.join(" ");
    else {
      const flag = args.findIndex((w) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
      if (flag !== -1) script = args[flag + 1] ?? null;
    }
    if (script !== null && shellCommands(script).some((inner) => checksOutPullRequest(inner, depth + 1))) return true;
  }
  const git = words.findIndex((w) => w === "git" || w.endsWith("/git"));
  if (git !== -1) {
    const rest = words.slice(git + 1);
    for (let i = 0; i < rest.length; i += 1) {
      const w = rest[i] ?? "";
      if (GIT_VALUE_OPTIONS.has(w)) i += 1;
      else if (!w.startsWith("-")) {
        if (GIT_BRINGS_CODE.has(w)) return true;
        if (w === "remote") {
          const after = rest.slice(i + 1);
          const verb = after.find((word) => !word.startsWith("-"));
          if (verb === "update" || (verb === "add" && after.some((word) => word === "-f" || word === "--fetch"))) return true;
        }
        break;
      }
    }
  }
  const gh = words.findIndex((w) => w === "gh" || w.endsWith("/gh"));
  if (gh !== -1) {
    const rest = words.slice(gh + 1).filter((w) => !w.startsWith("-"));
    const has = (/** @type {string} */ group, /** @type {string} */ verb) => {
      const at = rest.indexOf(group);
      return at !== -1 && rest.slice(at + 1).includes(verb);
    };
    if (has("pr", "checkout") || has("pr", "diff") || has("repo", "clone")) return true;
    if (has("repo", "fork") && words.slice(gh + 1).some((w) => w === "--clone" || w.startsWith("--clone="))) return true;
    const group = words.slice(gh + 1).findIndex((w) => !w.startsWith("-"));
    if (group !== -1 && words[gh + 1 + group] === "api" && unreadableEndpoint(words.slice(gh + 2 + group))) return true;
  }
  return false;
}

/**
 * Every rule, for every file, plus the rules across files: each required check's job lives only in its workflow, once.
 * @param {WorkflowFile[]} files
 * @returns {WorkflowViolation[]}
 */
export function checkWorkflows(files) {
  /** @type {WorkflowViolation[]} */
  const violations = [];
  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const file of files) {
    const result = checkOne(file);
    violations.push(...result.violations);
    for (const { name, line } of result.checkNames) {
      const home = REQUIRED_CHECKS.get(name);
      if (home !== baseName(file.path)) {
        violations.push({ file: file.path, line, rule: "required-check-name", detail: `only ${home} has a job named ${name}` });
        continue;
      }
      const count = (seen.get(name) ?? 0) + 1;
      seen.set(name, count);
      if (count > 1) {
        violations.push({ file: file.path, line, rule: "required-check-name", detail: `a second job named ${name}` });
      }
    }
  }
  return violations;
}
