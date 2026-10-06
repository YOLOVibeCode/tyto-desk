/**
 * The rules every workflow keeps (docs/IMPLEMENTATION.md §23.7). `lint:workflows` runs them on the checkout's
 * `.github/workflows/`, and `main`'s `pr-title` runs `main`'s copy on a pull request's workflow files, read through the
 * API as data. The YAML is parsed with `yaml`, never executed; shell in `run:` is tokenized, never run. A violation
 * names the file, the line and the rule, never more of the file.
 */
import { LineCounter, isAlias, isMap, isPair, isScalar, isSeq, parseDocument, visit } from "yaml";

/** @typedef {import("yaml").Document.Parsed} ParsedDocument */

/**
 * @typedef {"parse" | "yaml-alias" | "pinned-uses" | "top-permissions" | "job-permissions" | "timeout"
 *   | "persist-credentials" | "expression-in-run" | "pull-request-target" | "forbidden-trigger" | "write-scope"
 *   | "ignore-scripts" | "cache" | "debug-output" | "secret-environment" | "publish-environment"
 *   | "call-concurrency" | "required-check-name" | "runner"} WorkflowRule
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

/** Jobs whose output is attested or published: no cache may feed them. */
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
  return !rest.some((w) => w === "--ignore-scripts" || w === "--ignore-scripts=true");
}

/** Whether a simple command prints the environment or traces commands. @param {string[]} words */
function printsEnvironment(words) {
  const [name, ...args] = commandWords(words);
  if (name === undefined) return false;
  const traces = (/** @type {string} */ w) => /^[-+][a-zA-Z]*x[a-zA-Z]*$/.test(w);
  switch (name) {
    case "env":
      return args.every((w) => w.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    case "printenv":
      return true;
    case "set":
      return args.some(traces) || args.some((w, i) => w === "-o" && args[i + 1] === "xtrace");
    case "bash":
    case "sh":
    case "zsh":
      return args.some((w) => w.startsWith("-") && !w.startsWith("--") && w.includes("x"));
    case "export":
      return args.includes("-p");
    case "declare":
    case "typeset":
      return args.some((w) => /^-[a-zA-Z]*[px][a-zA-Z]*$/.test(w));
    case "compgen":
      return args.includes("-e") || args.includes("-v");
    default:
      return false;
  }
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

/** @param {unknown} uses */
function isCheckout(uses) {
  return typeof uses === "string" && uses.startsWith("actions/checkout@");
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

  let aliased = false;
  visit(doc, (_, node) => {
    const anchored = /** @type {{ anchor?: string }} */ (node).anchor;
    if (!aliased && (isAlias(node) || (typeof anchored === "string" && anchored !== ""))) {
      aliased = true;
      const range = /** @type {{ range?: [number, number, number] | null }} */ (node).range;
      violations.push({
        file: file.path,
        line: range ? counter.linePos(range[0]).line : null,
        rule: "yaml-alias",
        detail: "anchors and aliases hide what a job runs; spell every value out",
      });
    }
  });
  if (aliased) return { violations, checkNames };

  const workflow = asRecord(doc.toJS()) ?? {};
  const events = triggers(workflow.on);
  const pullRequestTarget = events.includes("pull_request_target");
  const reusable = events.includes("workflow_call");

  for (const event of events) {
    if (FORBIDDEN_TRIGGERS.has(event)) report(["on", event], "forbidden-trigger", `the ${event} trigger is never used`);
  }
  if (pullRequestTarget && !PULL_REQUEST_TARGET_FILES.has(name)) {
    report(["on", "pull_request_target"], "pull-request-target", "pull_request_target runs only in pr-title.yml, owner-merge.yml and dependabot-auto-merge.yml");
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
    const jobName = typeof job.name === "string" ? job.name : null;
    for (const checkName of new Set([id, ...(jobName === null ? [] : [jobName])])) {
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
      continue;
    }

    if (typeof job["runs-on"] !== "string" || !RUNNERS.has(job["runs-on"])) {
      report([...where, "runs-on"], "runner", "runners are ubuntu-24.04, ubuntu-24.04-arm or macos-26, never -latest");
    }
    if (job["timeout-minutes"] === undefined) report(where, "timeout", `${id} has no timeout-minutes`);

    const privileged =
      writes.length > 0 ||
      secrets.length > 0 ||
      (Array.isArray(job.steps) &&
        job.steps.some((step) => String(asRecord(step)?.uses ?? "").startsWith("actions/create-github-app-token@")));
    const noCache = pullRequestTarget || NO_CACHE_JOBS.has(id);
    if (privileged && [...jobStrings, ...workflowStrings].some((text) => /ACTIONS_(?:STEP|RUNNER)_DEBUG/.test(text))) {
      report(where, "debug-output", `${id} holds a secret or a write scope and must not turn on debug logging`);
    }

    const steps = Array.isArray(job.steps) ? job.steps : [];
    steps.forEach((value, index) => {
      const step = asRecord(value) ?? {};
      const stepPath = [...where, "steps", index];
      const uses = typeof step.uses === "string" ? step.uses : null;
      const withs = asRecord(step.with) ?? {};
      if (uses !== null && !uses.startsWith("./")) checkPinned(uses, [...stepPath, "uses"]);
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
      if (noCache && uses !== null) {
        if (/^actions\/cache(?:\/(?:restore|save))?@/.test(uses)) {
          report(stepPath, "cache", `${id} may not restore or save a cache`);
        } else if (uses.startsWith("actions/setup-node@") && (withs.cache !== undefined || !isFalse(withs["package-manager-cache"]))) {
          report(stepPath, "cache", `${id} runs setup-node with package-manager-cache: false and no cache`);
        }
      }
      const shell = typeof step.shell === "string" ? step.shell : "";
      if (privileged && shell !== "" && shellCommands(shell).some(printsEnvironment)) {
        report([...stepPath, "shell"], "debug-output", `${id} holds a secret or a write scope and must not trace its shell`);
      }
      const scripts = [
        ...(typeof step.run === "string" ? [{ text: step.run, key: "run" }] : []),
        ...(uses?.startsWith("actions/github-script@") && typeof withs.script === "string" ? [{ text: withs.script, key: "with" }] : []),
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
        if (privileged && commands.some(printsEnvironment)) {
          report([...stepPath, "run"], "debug-output", `${id} holds a secret or a write scope and must not print its environment`);
        }
        if (pullRequestTarget && commands.some((words) => checksOutPullRequest(words))) {
          report([...stepPath, "run"], "pull-request-target", "a pull_request_target workflow reads the pull request through the API, never with git");
        }
      }
    });
  }
  return { violations, checkNames };

}

/** git or gh commands that would bring the pull request's code onto the runner. @param {string[]} words */
function checksOutPullRequest(words) {
  const [name, sub] = commandWords(words);
  if (name === "git") return ["fetch", "checkout", "switch", "worktree", "clone", "pull", "restore"].includes(sub ?? "");
  if (name === "gh") return sub === "pr" && commandWords(words)[2] === "checkout";
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
