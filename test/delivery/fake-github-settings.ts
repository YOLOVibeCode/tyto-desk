import type { Runner, RunResult } from "../../scripts/delivery/lib/run.mjs";
import type { GhCall } from "./fake-gh.ts";

const ok = (stdout: unknown = ""): RunResult => ({
  code: 0,
  stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
  stderr: "",
});
const notFound = (): RunResult => ({
  code: 1,
  stdout: '{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}',
  stderr: "gh: Not Found (HTTP 404)\n",
});
/** What `gh secret list --env` and `gh variable list --env` print for an environment that does not exist. */
const listNotFound = (kind: string, environment: string): RunResult => ({
  code: 1,
  stdout: "",
  stderr: `failed to get ${kind}: HTTP 404: Not Found (https://api.github.com/repos/x/environments/${environment}/${kind}?per_page=100)\n`,
});
/** gh names a 409 only by its text; the status is in the body. */
const conflict = (message: string): RunResult => ({
  code: 1,
  stdout: JSON.stringify({ message: "Conflict", errors: message, documentation_url: "https://docs.github.com/rest", status: "409" }),
  stderr: `gh: ${message} (Conflict)\n`,
});

type Json = Record<string, unknown>;
type Ruleset = Json & { id: number; name: string };

/**
 * A repository's settings as the REST API shows them, in memory, starting from GitHub's defaults for a new public
 * repository. It answers the gh calls github-setup makes and records every one; reads add the extra fields GitHub
 * adds, so the script's comparisons must ignore them.
 */
export class FakeRepositorySettings {
  readonly calls: GhCall[] = [];
  readonly user = { login: "alex", id: 4242 };
  readonly apps: Record<string, number> = { "tyto-desk-release": 1234567 };
  repo: Json = {
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    allow_auto_merge: false,
    delete_branch_on_merge: false,
    squash_merge_commit_title: "COMMIT_OR_PR_TITLE",
    squash_merge_commit_message: "COMMIT_MESSAGES",
    allow_update_branch: false,
  };
  security: Record<string, { status: string }> = {
    secret_scanning: { status: "disabled" },
    secret_scanning_push_protection: { status: "disabled" },
    dependabot_security_updates: { status: "disabled" },
  };
  vulnerabilityAlerts = false;
  automatedSecurityFixes = false;
  privateReporting = false;
  actions: Json = { enabled: true, allowed_actions: "all", sha_pinning_required: false };
  selectedActions: Json | null = null;
  workflow: Json = { default_workflow_permissions: "read", can_approve_pull_request_reviews: false };
  forkApproval: Json = { approval_policy: "first_time_contributors" };
  immutable = false;
  environments = new Map<string, Json>();
  branchPolicies = new Map<string, { id: number; name: string; type: string }[]>();
  environmentSecrets = new Map<string, string[]>();
  environmentVariables = new Map<string, string[]>();
  repositorySecrets: string[] = [];
  labels = new Map<string, Json>([["bug", { name: "bug", color: "d73a4a", description: "Something isn't working" }]]);
  rulesets: Ruleset[] = [];
  private nextId = 100;

  readonly gh: Runner = async (args, options = {}) => {
    const input = options.input ?? "";
    this.calls.push({ args, input });
    return this.answer(args, input);
  };

  /** The calls that would change something. */
  writes(): string[] {
    return this.calls
      .filter((call) => {
        const method = call.args[call.args.indexOf("--method") + 1];
        return call.args[0] === "api" && call.args.includes("--method") && method !== "GET";
      })
      .map((call) => call.args.slice(0, 4).join(" "));
  }

  private answer(args: string[], input: string): RunResult {
    const body = (): Json => JSON.parse(input === "" ? "{}" : input) as Json;
    const joined = args.join(" ");
    if (joined === "api user --jq .login") return ok(`${this.user.login}\n`);
    if (joined === "api user --jq .id") return ok(`${this.user.id}\n`);
    let m = /^api apps\/([^ ]+) --jq \.id$/.exec(joined);
    if (m) return this.apps[m[1] ?? ""] === undefined ? notFound() : ok(`${this.apps[m[1] ?? ""]}\n`);
    m = /^secret list --repo [^ ]+(?: --env ([^ ]+))? --json name$/.exec(joined);
    if (m) {
      if (m[1] === undefined) return ok(this.repositorySecrets.map((name) => ({ name })));
      if (!this.environments.has(m[1])) return listNotFound("secrets", m[1]);
      return ok((this.environmentSecrets.get(m[1]) ?? []).map((name) => ({ name })));
    }
    m = /^variable list --repo [^ ]+ --env ([^ ]+) --json name$/.exec(joined);
    if (m) {
      if (!this.environments.has(m[1] ?? "")) return listNotFound("variables", m[1] ?? "");
      return ok((this.environmentVariables.get(m[1] ?? "") ?? []).map((name) => ({ name })));
    }
    m = /^api --method (GET|PUT|PATCH|POST|DELETE) repos\/YOLOVibeCode\/tyto-desk(\/[^ ?]*)?(\?[^ ]*)?(?: --input -)?$/.exec(joined);
    if (m === null) return { code: 1, stdout: "", stderr: `fake settings: no route for ${joined}` };
    const method = m[1] ?? "GET";
    const path = m[2] ?? "";
    switch (`${method} ${path.replace(/\/\d+$/, "/:id").replace(/environments\/[^/]+/, "environments/:env")}`) {
      case "GET ":
        return ok({ ...this.repo, id: 1, full_name: "YOLOVibeCode/tyto-desk", security_and_analysis: this.security });
      case "PATCH ": {
        const { security_and_analysis: security, ...rest } = body();
        Object.assign(this.repo, rest);
        if (security) Object.assign(this.security, security);
        return ok({ ...this.repo });
      }
      case "GET /vulnerability-alerts":
        return this.vulnerabilityAlerts ? ok("") : notFound();
      case "PUT /vulnerability-alerts":
        this.vulnerabilityAlerts = true;
        return ok("");
      case "GET /automated-security-fixes":
        return ok({ enabled: this.automatedSecurityFixes, paused: false });
      case "PUT /automated-security-fixes":
        this.automatedSecurityFixes = true;
        return ok("");
      case "GET /private-vulnerability-reporting":
        return ok({ enabled: this.privateReporting });
      case "PUT /private-vulnerability-reporting":
        this.privateReporting = true;
        return ok("");
      case "GET /actions/permissions":
        return ok({ ...this.actions, selected_actions_url: "https://api.github.com/x" });
      case "PUT /actions/permissions":
        this.actions = { ...this.actions, ...body() };
        return ok("");
      case "GET /actions/permissions/selected-actions":
        return this.actions.allowed_actions === "selected" && this.selectedActions !== null
          ? ok(this.selectedActions)
          : conflict("All actions and workflows are allowed on this repository");
      case "PUT /actions/permissions/selected-actions":
        this.selectedActions = body();
        return ok("");
      case "GET /actions/permissions/workflow":
        return ok(this.workflow);
      case "PUT /actions/permissions/workflow":
        this.workflow = body();
        return ok("");
      case "GET /actions/permissions/fork-pr-contributor-approval":
        return ok(this.forkApproval);
      case "PUT /actions/permissions/fork-pr-contributor-approval":
        this.forkApproval = body();
        return ok("");
      case "GET /immutable-releases":
        return this.immutable ? ok({ enabled: true, enforced_by_owner: false }) : notFound();
      case "PUT /immutable-releases":
        this.immutable = true;
        return ok("");
      case "GET /environments/:env":
        return this.environmentGet(path);
      case "PUT /environments/:env":
        return this.environmentPut(path, body());
      case "GET /environments/:env/deployment-branch-policies": {
        const policies = this.branchPolicies.get(this.environmentName(path)) ?? [];
        return ok({ total_count: policies.length, branch_policies: policies.map((p) => ({ ...p, node_id: "x" })) });
      }
      case "POST /environments/:env/deployment-branch-policies": {
        const name = this.environmentName(path);
        const { name: pattern, type } = body() as { name: string; type: string };
        this.branchPolicies.set(name, [...(this.branchPolicies.get(name) ?? []), { id: this.nextId++, name: pattern, type }]);
        return ok({});
      }
      case "DELETE /environments/:env/deployment-branch-policies/:id": {
        const name = this.environmentName(path);
        const id = Number(path.slice(path.lastIndexOf("/") + 1));
        this.branchPolicies.set(name, (this.branchPolicies.get(name) ?? []).filter((p) => p.id !== id));
        return ok("");
      }
      case "GET /labels/live":
      case "GET /labels/owner-merge": {
        const label = this.labels.get(decodeURIComponent(path.slice("/labels/".length)));
        return label === undefined ? notFound() : ok({ ...label, id: 9, default: false });
      }
      case "POST /labels": {
        const label = body();
        this.labels.set(String(label.name), label);
        return ok(label);
      }
      case "PATCH /labels/live":
      case "PATCH /labels/owner-merge": {
        const name = decodeURIComponent(path.slice("/labels/".length));
        this.labels.set(name, { ...this.labels.get(name), ...body() });
        return ok({});
      }
      case "GET /rulesets":
        return ok(this.rulesets.map(({ id, name, target, enforcement }) => ({ id, name, target, enforcement, source_type: "Repository" })));
      case "GET /rulesets/:id": {
        const ruleset = this.rulesets.find((r) => `/rulesets/${r.id}` === path);
        return ruleset === undefined ? notFound() : ok(this.withServerFields(ruleset));
      }
      case "POST /rulesets": {
        const ruleset = { ...body(), id: this.nextId++ } as Ruleset;
        this.rulesets.push(ruleset);
        return ok(ruleset);
      }
      case "PUT /rulesets/:id": {
        const at = this.rulesets.findIndex((r) => `/rulesets/${r.id}` === path);
        if (at === -1) return notFound();
        const id = this.rulesets[at]?.id ?? 0;
        this.rulesets[at] = { ...body(), id } as Ruleset;
        return ok({});
      }
      default:
        return { code: 1, stdout: "", stderr: `fake settings: no route for ${joined}` };
    }
  }

  private environmentName(path: string): string {
    return decodeURIComponent(path.split("/")[2] ?? "");
  }

  private environmentGet(path: string): RunResult {
    const name = this.environmentName(path);
    const env = this.environments.get(name);
    return env === undefined ? notFound() : ok(env);
  }

  private environmentPut(path: string, body: Json): RunResult {
    const name = this.environmentName(path);
    const reviewers = (body.reviewers as { type: string; id: number }[] | undefined) ?? [];
    const rules: Json[] = [];
    if (reviewers.length > 0) {
      rules.push({
        id: 1,
        type: "required_reviewers",
        prevent_self_review: body.prevent_self_review ?? false,
        reviewers: reviewers.map((r) => ({ type: r.type, reviewer: { id: r.id, login: r.id === this.user.id ? this.user.login : "x" } })),
      });
    }
    rules.push({ id: 2, type: "branch_policy" });
    this.environments.set(name, {
      id: 7,
      name,
      protection_rules: rules,
      deployment_branch_policy: body.deployment_branch_policy ?? null,
      can_admins_bypass: true,
    });
    return ok(this.environments.get(name));
  }

  /** What GitHub adds to a ruleset it returns. */
  private withServerFields(ruleset: Ruleset): Json {
    const rules = (ruleset.rules as Json[]).map((rule) =>
      rule.type === "pull_request"
        ? { ...rule, parameters: { ...(rule.parameters as Json), automatic_copilot_code_review_enabled: false, required_reviewers: [] } }
        : rule,
    );
    return {
      ...ruleset,
      rules,
      source_type: "Repository",
      source: "YOLOVibeCode/tyto-desk",
      node_id: "RRS_x",
      created_at: "2026-10-06T18:00:00Z",
      updated_at: "2026-10-06T18:00:00Z",
      current_user_can_bypass: "never",
      _links: { self: { href: "https://api.github.com/x" } },
    };
  }
}
