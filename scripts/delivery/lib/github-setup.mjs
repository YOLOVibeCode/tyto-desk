/**
 * Every repository setting, in one idempotent script (docs/IMPLEMENTATION.md §23.2). `check` reads each setting through
 * `gh api`, prints desired and actual values by name, and changes nothing; `apply` asks on an interactive terminal,
 * changes only what differs, reads it back, and prints the same table. gh runs with argv arrays. The signed-in account
 * is named with `gh api user`. Secrets are only ever listed by name (`gh secret list`), and never set or removed here:
 * the operator does that by hand (RELEASING.md).
 */
import { GhError, ghOk, httpStatus, isNotFound, segment } from "./gh.mjs";

/** @typedef {import("./run.mjs").Runner} Runner */
/** @typedef {Record<string, unknown>} Json */

/** GitHub Actions' app id: the required checks must come from it. */
export const GITHUB_ACTIONS_APP_ID = 15368;
export const RELEASE_APP_SECRET = "RELEASE_APP_PRIVATE_KEY";
export const RELEASE_APP_VARIABLE = "RELEASE_APP_CLIENT_ID";

const CUSTOM_BRANCH_POLICY = { protected_branches: false, custom_branch_policies: true };

/**
 * What every setting should be.
 * @param {{ ownerId: number; appId: number | null }} who the owner (publish's reviewer) and the release App, if it exists
 */
export function desiredSettings({ ownerId, appId }) {
  const app = appId === null ? [] : [{ actor_id: appId, actor_type: "Integration", bypass_mode: "always" }];
  const appOnly = [
    { type: "creation" },
    { type: "update", parameters: { update_allows_fetch_and_merge: false } },
    { type: "deletion" },
    { type: "non_fast_forward" },
  ];
  return {
    merging: {
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      allow_auto_merge: true,
      delete_branch_on_merge: true,
      squash_merge_commit_title: "PR_TITLE",
      squash_merge_commit_message: "PR_BODY",
      allow_update_branch: true,
    },
    secretScanning: { secret_scanning: "enabled", secret_scanning_push_protection: "enabled" },
    actions: { enabled: true, allowed_actions: "selected", sha_pinning_required: true },
    selectedActions: {
      github_owned_allowed: true,
      verified_allowed: false,
      patterns_allowed: ["dependabot/fetch-metadata@*", "googleapis/release-please-action@*"],
    },
    workflow: { default_workflow_permissions: "read", can_approve_pull_request_reviews: false },
    forkApproval: { approval_policy: "all_external_contributors" },
    environments: {
      "release-please": {
        reviewers: [],
        deployment_branch_policy: CUSTOM_BRANCH_POLICY,
        branch_policies: [{ name: "main", type: "branch" }],
      },
      publish: {
        reviewers: [{ type: "User", id: ownerId }],
        prevent_self_review: false,
        deployment_branch_policy: CUSTOM_BRANCH_POLICY,
        branch_policies: [{ name: "v*", type: "tag" }],
      },
    },
    labels: {
      live: { name: "live", color: "0e8a16", description: "Runs the live suite on this pull request" },
      "owner-merge": { name: "owner-merge", color: "b60205", description: "The owner merges this by hand after reading the diff" },
    },
    rulesets: {
      main: {
        name: "main",
        target: "branch",
        enforcement: "active",
        bypass_actors: [],
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        rules: [
          { type: "deletion" },
          { type: "non_fast_forward" },
          { type: "required_linear_history" },
          { type: "required_signatures" },
          {
            type: "pull_request",
            parameters: {
              required_approving_review_count: 0,
              dismiss_stale_reviews_on_push: false,
              require_code_owner_review: false,
              require_last_push_approval: false,
              required_review_thread_resolution: false,
              allowed_merge_methods: ["squash"],
            },
          },
          {
            type: "required_status_checks",
            parameters: {
              strict_required_status_checks_policy: false,
              do_not_enforce_on_create: false,
              required_status_checks: [
                { context: "pr-title", integration_id: GITHUB_ACTIONS_APP_ID },
                { context: "ci-ok", integration_id: GITHUB_ACTIONS_APP_ID },
              ],
            },
          },
        ],
      },
      tags: {
        name: "tags",
        target: "tag",
        enforcement: "active",
        bypass_actors: app,
        conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
        rules: appOnly,
      },
      "release branch": {
        name: "release branch",
        target: "branch",
        enforcement: "active",
        bypass_actors: app,
        conditions: { ref_name: { include: ["refs/heads/release-please--**"], exclude: [] } },
        rules: appOnly,
      },
    },
  };
}

/** @typedef {ReturnType<typeof desiredSettings>} Desired */

/** JSON with keys sorted, so equal values print and compare alike. @param {unknown} value @returns {string} */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = /** @type {Json} */ (value);
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** @param {unknown} value @returns {Json} */
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? /** @type {Json} */ (value) : {};
}

/** @param {unknown} value @returns {unknown[]} */
function list(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {Json} source @param {readonly string[]} keys @returns {Json} */
function pick(source, keys) {
  /** @type {Json} */
  const picked = {};
  for (const key of keys) picked[key] = source[key];
  return picked;
}

/** A ruleset as compared: rules sorted by type, lists in a stable order, only the parameters desired names. */
/** @param {Json} ruleset @param {Json} desired @returns {Json} */
function canonicalRuleset(ruleset, desired) {
  const wanted = /** @type {Json[]} */ (list(desired.rules));
  const rules = list(ruleset.rules)
    .map((value) => {
      const rule = record(value);
      const want = wanted.find((w) => w.type === rule.type);
      if (want === undefined) return { type: rule.type, parameters: rule.parameters };
      if (want.parameters === undefined) return { type: rule.type };
      const parameters = pick(record(rule.parameters), Object.keys(record(want.parameters)));
      if (Array.isArray(parameters.required_status_checks)) {
        parameters.required_status_checks = parameters.required_status_checks
          .map((check) => pick(record(check), ["context", "integration_id"]))
          .sort((a, b) => String(a.context).localeCompare(String(b.context)));
      }
      if (Array.isArray(parameters.allowed_merge_methods)) parameters.allowed_merge_methods = [...parameters.allowed_merge_methods].sort();
      return { type: rule.type, parameters };
    })
    .sort((a, b) => String(a.type).localeCompare(String(b.type)));
  const conditions = record(record(ruleset.conditions).ref_name);
  return {
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    bypass_actors: list(ruleset.bypass_actors).map((actor) => pick(record(actor), ["actor_id", "actor_type", "bypass_mode"])),
    conditions: { ref_name: { include: list(conditions.include), exclude: list(conditions.exclude) } },
    rules,
  };
}

/**
 * @typedef {{
 *   gh: Runner;
 *   repository: string;
 *   memo: <T>(key: string, read: () => Promise<T>) => Promise<T>;
 * }} Context
 */

/**
 * One setting: how to read it as a value comparable with `desired`, and how to change it, if github-setup may.
 * @typedef {{
 *   name: string;
 *   desired: unknown;
 *   read: (ctx: Context) => Promise<unknown>;
 *   apply?: (ctx: Context) => Promise<void>;
 *   byHand?: string;
 *   later?: string;
 * }} Setting
 */

/**
 * @param {Context} ctx
 * @param {string} path
 * @param {{ conflictIsAbsent?: boolean }} [options] `selected-actions` answers 409 while the policy is not "selected"
 * @returns {Promise<unknown>} the parsed JSON, or null on 404 (and on 409 when asked)
 */
async function getJson(ctx, path, options = {}) {
  const args = ["api", "--method", "GET", path.startsWith("repos/") ? path : `repos/${ctx.repository}${path}`];
  const result = await ctx.gh(args);
  if (isNotFound(result)) return null;
  if (options.conflictIsAbsent && httpStatus(result) === 409) return null;
  if (result.code !== 0) throw new GhError(args, result);
  return result.stdout.trim() === "" ? {} : JSON.parse(result.stdout);
}

/** @param {Context} ctx @param {"PUT" | "PATCH" | "POST" | "DELETE"} method @param {string} path @param {unknown} [body] */
async function send(ctx, method, path, body) {
  const args = ["api", "--method", method, `repos/${ctx.repository}${path}`];
  const result = await ctx.gh(body === undefined ? args : [...args, "--input", "-"], body === undefined ? {} : { input: JSON.stringify(body) });
  if (result.code !== 0) throw new GhError(args, result);
}

/** Secret or variable names, listed by gh; an environment that does not exist has none. */
/** @param {Context} ctx @param {"secret" | "variable"} kind @param {string | null} environment */
async function names(ctx, kind, environment) {
  const args = [kind, "list", "--repo", ctx.repository, ...(environment === null ? [] : ["--env", environment]), "--json", "name"];
  return ctx.memo(args.join(" "), async () => {
    const result = await ctx.gh(args);
    if (isNotFound(result)) return [];
    if (result.code !== 0) throw new GhError(args, result);
    return list(JSON.parse(result.stdout || "[]"))
      .map((item) => String(record(item).name))
      .sort();
  });
}

/** @param {string} name @param {Json} desired @returns {Setting} */
function environmentSetting(name, desired) {
  const path = `/environments/${segment(name)}`;
  /** @param {Context} ctx */
  const policies = async (ctx) =>
    list(record(await getJson(ctx, `${path}/deployment-branch-policies?per_page=100`)).branch_policies).map(record);
  return {
    name: `environment ${name}`,
    desired,
    async read(ctx) {
      const env = await getJson(ctx, path);
      if (env === null) return null;
      const rules = list(record(env).protection_rules).map(record);
      const reviewers = record(rules.find((rule) => rule.type === "required_reviewers"));
      /** @type {Json} */
      const actual = {
        reviewers: list(reviewers.reviewers).map((r) => ({ type: record(r).type, id: record(record(r).reviewer).id })),
        prevent_self_review: reviewers.prevent_self_review ?? false,
        deployment_branch_policy: pick(record(record(env).deployment_branch_policy), ["protected_branches", "custom_branch_policies"]),
        branch_policies: (await policies(ctx))
          .map((p) => ({ name: p.name, type: p.type }))
          .sort((a, b) => stableJson(a).localeCompare(stableJson(b))),
      };
      return pick(actual, Object.keys(desired));
    },
    async apply(ctx) {
      const { branch_policies: wanted, ...settings } = desired;
      await send(ctx, "PUT", path, { wait_timer: 0, ...settings });
      const current = await policies(ctx);
      const want = list(wanted).map(record);
      for (const policy of current) {
        if (!want.some((w) => w.name === policy.name && w.type === policy.type)) {
          await send(ctx, "DELETE", `${path}/deployment-branch-policies/${Number(policy.id)}`);
        }
      }
      for (const w of want) {
        if (!current.some((policy) => policy.name === w.name && policy.type === w.type)) {
          await send(ctx, "POST", `${path}/deployment-branch-policies`, { name: w.name, type: w.type });
        }
      }
    },
  };
}

/** @param {Json} desired @returns {Setting} */
function labelSetting(desired) {
  const name = String(desired.name);
  return {
    name: `label ${name}`,
    desired,
    async read(ctx) {
      const label = await getJson(ctx, `/labels/${segment(name)}`);
      return label === null ? null : pick(record(label), ["name", "color", "description"]);
    },
    async apply(ctx) {
      const label = await getJson(ctx, `/labels/${segment(name)}`);
      if (label === null) await send(ctx, "POST", "/labels", desired);
      else await send(ctx, "PATCH", `/labels/${segment(name)}`, { color: desired.color, description: desired.description });
    },
  };
}

/** @param {Json} desired @returns {Setting} */
function rulesetSetting(desired) {
  /** @param {Context} ctx */
  const find = async (ctx) => {
    const all = await ctx.memo("rulesets", async () => list(await getJson(ctx, "/rulesets?includes_parents=false&per_page=100")));
    const found = all.map(record).find((r) => r.name === desired.name && (r.source_type ?? "Repository") === "Repository");
    return found === undefined ? null : Number(found.id);
  };
  return {
    name: `ruleset ${desired.name}`,
    desired: canonicalRuleset(desired, desired),
    async read(ctx) {
      const id = await find(ctx);
      if (id === null) return null;
      const ruleset = await getJson(ctx, `/rulesets/${id}`);
      return ruleset === null ? null : canonicalRuleset(record(ruleset), desired);
    },
    async apply(ctx) {
      const id = await find(ctx);
      if (id === null) await send(ctx, "POST", "/rulesets", desired);
      else await send(ctx, "PUT", `/rulesets/${id}`, desired);
    },
  };
}

/**
 * Every setting, in the order `apply` changes them (alerts before security updates, the actions policy before its
 * allowlist, rulesets last).
 * @param {Desired} desired
 * @param {{ appSlug: string | null }} app
 * @returns {Setting[]}
 */
export function settingsFor(desired, { appSlug }) {
  /** @param {Context} ctx */
  const repository = (ctx) => ctx.memo("repository", async () => record(await getJson(ctx, "")));
  /**
   * @param {string} name @param {string} path @param {Json} want
   * @param {(body: unknown) => Json | null} [shape]
   * @param {{ conflictIsAbsent?: boolean }} [options]
   * @returns {Setting}
   */
  const simple = (name, path, want, shape = (body) => pick(record(body), Object.keys(want)), options = {}) => ({
    name,
    desired: want,
    read: async (ctx) => shape(await getJson(ctx, path, options)),
    apply: (ctx) => send(ctx, "PUT", path, want),
  });
  /** @param {string} name @param {string} path @returns {Setting} */
  const enabled = (name, path) => ({
    name,
    desired: { enabled: true },
    read: async (ctx) => {
      const body = await getJson(ctx, path);
      return { enabled: body !== null && (record(body).enabled ?? true) === true };
    },
    apply: (ctx) => send(ctx, "PUT", path),
  });
  /** @type {Setting[]} */
  const settings = [
    {
      name: "merging",
      desired: desired.merging,
      read: async (ctx) => pick(await repository(ctx), Object.keys(desired.merging)),
      apply: (ctx) => send(ctx, "PATCH", "", desired.merging),
    },
    {
      name: "secret scanning",
      desired: desired.secretScanning,
      read: async (ctx) => {
        const analysis = record((await repository(ctx)).security_and_analysis);
        return {
          secret_scanning: record(analysis.secret_scanning).status ?? "disabled",
          secret_scanning_push_protection: record(analysis.secret_scanning_push_protection).status ?? "disabled",
        };
      },
      apply: (ctx) =>
        send(ctx, "PATCH", "", {
          security_and_analysis: {
            secret_scanning: { status: "enabled" },
            secret_scanning_push_protection: { status: "enabled" },
          },
        }),
    },
    enabled("dependabot alerts", "/vulnerability-alerts"),
    enabled("dependabot security updates", "/automated-security-fixes"),
    enabled("private vulnerability reporting", "/private-vulnerability-reporting"),
    simple("actions", "/actions/permissions", desired.actions),
    simple("allowed actions", "/actions/permissions/selected-actions", desired.selectedActions, (body) => {
      if (body === null) return null;
      const actual = pick(record(body), Object.keys(desired.selectedActions));
      return { ...actual, patterns_allowed: list(actual.patterns_allowed).map(String).sort() };
    }, { conflictIsAbsent: true }),
    simple("workflow token", "/actions/permissions/workflow", desired.workflow),
    simple("outside contributors", "/actions/permissions/fork-pr-contributor-approval", desired.forkApproval),
    enabled("immutable releases", "/immutable-releases"),
    environmentSetting("release-please", desired.environments["release-please"]),
    environmentSetting("publish", desired.environments.publish),
    {
      name: "secrets",
      desired: { repository: [], "release-please": [], publish: [] },
      byHand: `v1 has one secret, ${RELEASE_APP_SECRET}, in the release-please environment (D52): remove any other by hand`,
      read: async (ctx) => ({
        repository: await names(ctx, "secret", null),
        "release-please": (await names(ctx, "secret", "release-please")).filter((n) => n !== RELEASE_APP_SECRET),
        publish: await names(ctx, "secret", "publish"),
      }),
    },
    appSlug === null
      ? {
          name: "release-please secrets",
          desired: null,
          later: "set by hand once the Desk Release App exists (RELEASING.md, one-time setup 2)",
          read: async () => null,
        }
      : {
          name: "release-please secrets",
          desired: { variables: [RELEASE_APP_VARIABLE], secrets: [RELEASE_APP_SECRET] },
          byHand: "set the App's client id and key by hand (RELEASING.md, one-time setup 2); github-setup never handles a secret",
          read: async (ctx) => ({
            variables: (await names(ctx, "variable", "release-please")).filter((n) => n === RELEASE_APP_VARIABLE),
            secrets: (await names(ctx, "secret", "release-please")).filter((n) => n === RELEASE_APP_SECRET),
          }),
        },
    labelSetting(desired.labels.live),
    labelSetting(desired.labels["owner-merge"]),
    rulesetSetting(desired.rulesets.main),
    rulesetSetting(desired.rulesets.tags),
    rulesetSetting(desired.rulesets["release branch"]),
  ];
  return settings;
}

/** @typedef {{ setting: Setting; actual: unknown; state: "ok" | "differs" | "later" }} SettingState */

/** @param {Setting[]} settings @param {Omit<Context, "memo">} base @returns {Promise<SettingState[]>} */
async function readAll(settings, base) {
  /** @type {Map<string, Promise<unknown>>} */
  const cache = new Map();
  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} read
   * @returns {Promise<T>}
   */
  function memo(key, read) {
    const hit = cache.get(key);
    if (hit !== undefined) return /** @type {Promise<T>} */ (hit);
    const value = read();
    cache.set(key, value);
    return value;
  }
  /** @type {Context} */
  const ctx = { ...base, memo };
  /** @type {SettingState[]} */
  const states = [];
  for (const setting of settings) {
    if (setting.later !== undefined) {
      states.push({ setting, actual: null, state: "later" });
      continue;
    }
    const actual = await setting.read(ctx);
    states.push({ setting, actual, state: stableJson(actual) === stableJson(setting.desired) ? "ok" : "differs" });
  }
  return states;
}

/** @param {SettingState[]} states @param {(line: string) => void} print */
function printTable(states, print) {
  for (const { setting, actual, state } of states) {
    if (state === "later") {
      print(`  ${"later".padEnd(8)} ${setting.name}: ${setting.later}`);
    } else if (state === "ok") {
      print(`  ${"ok".padEnd(8)} ${setting.name}  ${stableJson(actual)}`);
    } else {
      print(`  ${"differs".padEnd(8)} ${setting.name}${setting.byHand ? ` (by hand: ${setting.byHand})` : ""}`);
      print(`             desired ${stableJson(setting.desired)}`);
      print(`             actual  ${stableJson(actual)}`);
    }
  }
}

/**
 * `github-setup --check` or `--apply`. Returns the exit code: 0 clean, 1 something differs (or `--apply` was refused
 * without a terminal), 77 the operator declined.
 * @param {{
 *   mode: "check" | "apply";
 *   gh: Runner;
 *   repository: string;
 *   appSlug: string | null;
 *   isTTY: boolean;
 *   confirm: (question: string) => Promise<boolean>;
 *   print: (line: string) => void;
 * }} options
 * @returns {Promise<number>}
 */
export async function runSetup({ mode, gh, repository, appSlug, isTTY, confirm, print }) {
  if (mode === "apply" && !isTTY) {
    print("github-setup: --apply asks on an interactive terminal; there is no --yes. Nothing changed.");
    return 1;
  }
  const login = (await ghOk(gh, ["api", "user", "--jq", ".login"])).trim();
  const ownerId = Number((await ghOk(gh, ["api", "user", "--jq", ".id"])).trim());
  /** @type {number | null} */
  let appId = null;
  if (appSlug !== null) {
    const app = await gh(["api", `apps/${segment(appSlug)}`, "--jq", ".id"]);
    appId = app.code === 0 && /^\d+$/.test(app.stdout.trim()) ? Number(app.stdout.trim()) : null;
    if (appId === null) {
      print(`github-setup: the release App ${appSlug} was not found; check RELEASE_APP_SLUG. Nothing changed.`);
      return 1;
    }
  }
  const settings = settingsFor(desiredSettings({ ownerId, appId }), { appSlug });
  const base = { gh, repository };
  let states = await readAll(settings, base);
  print(`${repository}, as ${login}:`);
  printTable(states, print);
  const differing = states.filter((s) => s.state === "differs");
  if (mode === "check") {
    print(differing.length === 0 ? "Clean: every setting is as desired." : `${differing.length} setting(s) differ: ${differing.map((s) => s.setting.name).join(", ")}`);
    return differing.length === 0 ? 0 : 1;
  }
  const changes = differing.filter((s) => s.setting.apply !== undefined);
  if (changes.length === 0) {
    print(differing.length === 0 ? "Nothing to change." : "Nothing github-setup may change; the rest is by hand (above).");
    return differing.length === 0 ? 0 : 1;
  }
  const question = `Apply ${changes.length} change(s) to ${repository} as ${login} (${changes.map((s) => s.setting.name).join(", ")})?`;
  if (!(await confirm(question))) {
    print("Declined. Nothing changed.");
    return 77;
  }
  for (const { setting } of changes) {
    await setting.apply?.({ ...base, memo: (_key, read) => read() });
    print(`Changed ${setting.name}`);
  }
  states = await readAll(settings, base);
  print("Read back:");
  printTable(states, print);
  const left = states.filter((s) => s.state === "differs");
  print(left.length === 0 ? "Clean: every setting is as desired." : `${left.length} setting(s) still differ: ${left.map((s) => s.setting.name).join(", ")}`);
  return left.length === 0 ? 0 : 1;
}
