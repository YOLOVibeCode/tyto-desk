import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { actionPins, checkWorkflows } from "../../scripts/delivery/lib/workflow-rules.mjs";
import { repo, runScript, tempTree } from "./helpers.ts";

const lint = join(repo, "scripts/delivery/lint-workflows.mjs");
const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const CHECKOUT = `actions/checkout@${SHA} # v7.0.1`;
const SETUP_NODE = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0";
const CACHE = "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0";
const APP_TOKEN = "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0";

/** A job that keeps every rule: `extra` lines go at the job level, `steps` after the checkout. */
function job(id: string, { extra = "", steps = "", runsOn = "ubuntu-24.04" } = {}): string {
  return [
    `  ${id}:`,
    `    runs-on: ${runsOn}`,
    "    timeout-minutes: 10",
    "    permissions:",
    "      contents: read",
    ...(extra === "" ? [] : extra.split("\n").map((line) => `    ${line}`)),
    "    steps:",
    `      - uses: ${CHECKOUT}`,
    "        with:",
    "          persist-credentials: false",
    ...(steps === "" ? [] : steps.split("\n").map((line) => `      ${line}`)),
  ].join("\n");
}

/** A workflow that keeps every rule. */
function workflow({ on = "push:\n    branches: [main]", top = "permissions: {}", jobs = job("build") } = {}): string {
  return ["name: x", "on:", `  ${on}`, top, "jobs:", jobs, ""].join("\n");
}

function rulesBroken(file: string, text: string): string[] {
  return checkWorkflows([{ path: `.github/workflows/${file}`, text }]).map((violation) => violation.rule);
}

describe("lint:workflows", () => {
  it("lint:workflows passes a workflow that keeps every rule", () => {
    expect(checkWorkflows([{ path: ".github/workflows/ci.yml", text: workflow() }])).toEqual([]);
  });

  it.each([
    ["an action pinned to a tag", "ci.yml", workflow({ jobs: job("build").replace(CHECKOUT, "actions/checkout@v7.0.1") }), "pinned-uses"],
    ["an action pinned to a SHA without its tag in a comment", "ci.yml", workflow({ jobs: job("build").replace(" # v7.0.1", "") }), "pinned-uses"],
    ["an action pinned to a short SHA", "ci.yml", workflow({ jobs: job("build").replace(SHA, SHA.slice(0, 12)) }), "pinned-uses"],
    ["a Docker action", "ci.yml", workflow({ jobs: job("build", { steps: "- uses: docker://alpine:3" }) }), "pinned-uses"],
    ["no top-level permissions", "ci.yml", workflow({ top: "" }), "top-permissions"],
    ["top-level permissions that grant a scope", "ci.yml", workflow({ top: "permissions:\n  contents: read" }), "top-permissions"],
    ["a job without timeout-minutes", "ci.yml", workflow({ jobs: job("build").replace("    timeout-minutes: 10\n", "") }), "timeout"],
    ["a checkout without persist-credentials false", "ci.yml", workflow({ jobs: job("build").replace("persist-credentials: false", "fetch-depth: 0") }), "persist-credentials"],
    ["a checkout that persists credentials", "ci.yml", workflow({ jobs: job("build").replace("persist-credentials: false", "persist-credentials: true") }), "persist-credentials"],
    ["${{ github.* }} inside run", "ci.yml", workflow({ jobs: job("build", { steps: '- run: echo "${{ github.event.pull_request.title }}"' }) }), "expression-in-run"],
    ["${{ inputs.* }} inside run", "ci.yml", workflow({ jobs: job("build", { steps: "- run: echo ${{ inputs.ref }}" }) }), "expression-in-run"],
    ["pull_request_target outside its three workflows", "ci.yml", workflow({ on: "pull_request_target:" }), "pull-request-target"],
    [
      "a pull_request_target workflow that checks out the pull request",
      "pr-title.yml",
      workflow({ on: "pull_request_target:", jobs: job("check").replace("persist-credentials: false", "persist-credentials: false\n          ref: ${{ github.event.pull_request.head.sha }}") }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that fetches the pull request",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: '- run: git fetch origin "pull/$PR/head"' }) }),
      "pull-request-target",
    ],
    ["workflow_run", "ci.yml", workflow({ on: "workflow_run:\n    workflows: [ci]" }), "forbidden-trigger"],
    ["issue_comment", "ci.yml", workflow({ on: "issue_comment:" }), "forbidden-trigger"],
    ["pull_request_review", "ci.yml", workflow({ on: "pull_request_review:" }), "forbidden-trigger"],
    ["pull_request_review_comment", "ci.yml", workflow({ on: "pull_request_review_comment:" }), "forbidden-trigger"],
    ["repository_dispatch", "ci.yml", workflow({ on: "repository_dispatch:" }), "forbidden-trigger"],
    ["id-token write outside its jobs", "ci.yml", workflow({ jobs: job("build", { extra: "" }).replace("contents: read", "contents: read\n      id-token: write") }), "write-scope"],
    ["contents write outside its jobs", "release.yml", workflow({ jobs: job("plan").replace("contents: read", "contents: write") }), "write-scope"],
    ["pull-requests write outside its jobs", "ci.yml", workflow({ jobs: job("build").replace("contents: read", "contents: read\n      pull-requests: write") }), "write-scope"],
    ["attestations write outside its jobs", "release.yml", workflow({ jobs: job("build").replace("contents: read", "contents: read\n      attestations: write") }), "write-scope"],
    ["a job with write-all", "ci.yml", workflow({ jobs: job("build").replace("permissions:\n      contents: read", "permissions: write-all") }), "write-scope"],
    ["npm ci without --ignore-scripts", "ci.yml", workflow({ jobs: job("build", { steps: "- run: npm ci && npm test" }) }), "ignore-scripts"],
    ["npm install without --ignore-scripts", "ci.yml", workflow({ jobs: job("build", { steps: "- run: |\n    npm install --save-dev x" }) }), "ignore-scripts"],
    ["npm ci with --ignore-scripts=false", "ci.yml", workflow({ jobs: job("build", { steps: "- run: npm ci --ignore-scripts=false" }) }), "ignore-scripts"],
    ["a cache in a pull_request_target job", "pr-title.yml", workflow({ on: "pull_request_target:", jobs: job("check", { steps: `- uses: ${CACHE}\n  with:\n    path: x\n    key: y` }) }), "cache"],
    ["setup-node's cache in a pack job", "build-darwin.yml", workflow({ jobs: job("pack", { steps: `- uses: ${SETUP_NODE}\n  with:\n    cache: npm\n    package-manager-cache: false` }) }), "cache"],
    ["setup-node without package-manager-cache false in an attest job", "edge.yml", workflow({ jobs: job("attest", { steps: `- uses: ${SETUP_NODE}` }) }), "cache"],
    ["a cache in a publish job", "release.yml", workflow({ jobs: job("publish", { extra: "environment: publish", steps: `- uses: ${CACHE.replace("actions/cache@", "actions/cache/restore@")}\n  with:\n    path: x\n    key: y` }) }), "cache"],
    ["env in a job with a write scope", "owner-merge.yml", workflow({ jobs: job("owner-merge", { steps: "- run: env | sort" }).replace("contents: read", "contents: read\n      pull-requests: write") }), "debug-output"],
    ["printenv in a job with a secret", "release-please.yml", workflow({ jobs: job("release-please", { extra: "environment: release-please", steps: "- run: printenv\n  env:\n    KEY: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}" }) }), "debug-output"],
    ["set -x in a job with the App's token", "release-please.yml", workflow({ jobs: job("release-please", { steps: `- uses: ${APP_TOKEN}\n- run: |\n    set -euxo pipefail\n    echo hi` }) }), "debug-output"],
    ["ACTIONS_STEP_DEBUG in a job with a write scope", "release.yml", workflow({ jobs: job("publish", { extra: "environment: publish\nenv:\n  ACTIONS_STEP_DEBUG: true" }).replace("contents: read", "contents: write") }), "debug-output"],
    ["a secret outside its environment's job", "ci.yml", workflow({ jobs: job("build", { steps: "- run: echo hi\n  env:\n    KEY: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}" }) }), "secret-environment"],
    ["a secret that no environment holds", "release-please.yml", workflow({ jobs: job("release-please", { extra: "environment: release-please", steps: "- run: echo hi\n  env:\n    KEY: ${{ secrets.NPM_TOKEN }}" }) }), "secret-environment"],
    ["secrets: inherit", "ci.yml", workflow({ jobs: "  build:\n    uses: ./.github/workflows/build-darwin.yml\n    permissions:\n      contents: read\n    secrets: inherit" }), "secret-environment"],
    ["every secret at once", "release-please.yml", workflow({ jobs: job("release-please", { extra: "environment: release-please", steps: "- run: echo hi\n  env:\n    ALL: ${{ toJSON(secrets) }}" }) }), "secret-environment"],
    ["a publish job outside the publish environment", "release.yml", workflow({ jobs: job("publish") }), "publish-environment"],
    ["concurrency in a workflow_call workflow", "build-darwin.yml", workflow({ on: "workflow_call:", top: "permissions: {}\nconcurrency:\n  group: x" }), "call-concurrency"],
    ["job-level concurrency in a workflow_call workflow", "live-run.yml", workflow({ on: "workflow_call:", jobs: job("live", { extra: "concurrency: live" }) }), "call-concurrency"],
    ["a job named ci-ok outside ci.yml", "edge.yml", workflow({ jobs: job("ci-ok") }), "required-check-name"],
    ["a job named pr-title outside pr-title.yml", "ci.yml", workflow({ jobs: job("build", { extra: "name: pr-title" }) }), "required-check-name"],
    ["a second job named ci-ok", "ci.yml", workflow({ jobs: `${job("ci-ok")}\n${job("other", { extra: "name: ci-ok" })}` }), "required-check-name"],
    ["a runner label ending in -latest", "ci.yml", workflow({ jobs: job("build", { runsOn: "ubuntu-latest" }) }), "runner"],
    ["a self-hosted runner", "ci.yml", workflow({ jobs: job("build", { runsOn: "[self-hosted, linux]" }) }), "runner"],
    ["a YAML alias", "ci.yml", workflow({ jobs: job("build", { extra: "env: &shared\n  A: b" }) + "\n" + job("other", { extra: "env: *shared" }) }), "yaml-alias"],
    ["a file that does not parse", "ci.yml", "on: [push\njobs: {", "parse"],
  ])("lint:workflows fails on %s", (_label, file, text, rule) => {
    expect(rulesBroken(file, text)).toEqual([rule]);
  });

  it("lint:workflows allows ${{ matrix.* }} and ${{ runner.* }} inside run, and expressions in env", () => {
    const text = workflow({
      jobs: job("build", {
        steps: [
          '- run: echo "${{ matrix.node }}" "${{ runner.temp }}" "$TITLE"',
          "  env:",
          "    TITLE: ${{ github.event.pull_request.title }}",
          "- run: npm --prefix packages/core ci --ignore-scripts && npm run check",
          "- run: echo 'npm ci is in a string' # npm install in a comment",
          "- run: node scripts/check-secrets.mjs --secrets.KEY",
        ].join("\n"),
      }),
    });

    expect(checkWorkflows([{ path: ".github/workflows/ci.yml", text }])).toEqual([]);
  });

  it("lint:workflows allows the write scopes, environments and secrets each job is given", () => {
    const files = [
      {
        path: ".github/workflows/release.yml",
        text: workflow({
          on: "push:\n    tags: ['v*']",
          jobs: job("publish", { extra: "environment: publish" }).replace(
            "contents: read",
            "contents: write\n      id-token: write\n      attestations: write",
          ),
        }),
      },
      {
        path: ".github/workflows/release-please.yml",
        text: workflow({
          jobs: job("release-please", {
            extra: "environment:\n  name: release-please\n  deployment: false",
            steps: `- uses: ${APP_TOKEN}\n  with:\n    client-id: \${{ vars.RELEASE_APP_CLIENT_ID }}\n    private-key: \${{ secrets.RELEASE_APP_PRIVATE_KEY }}`,
          }),
        }),
      },
      {
        path: ".github/workflows/owner-merge.yml",
        text: workflow({
          on: "pull_request_target:\n    types: [opened]",
          jobs: job("owner-merge").replace("contents: read", "contents: read\n      pull-requests: write"),
        }),
      },
    ];

    expect(checkWorkflows(files)).toEqual([]);
  });

  it("lint:workflows names the file, line and rule of each violation", async () => {
    const root = await tempTree("workflows-", {
      ".github/workflows/ci.yml": workflow({ jobs: job("build", { runsOn: "macos-latest" }) }),
      ".github/workflows/ok.yml": workflow(),
    });

    const result = await runScript(lint, ["--root", root]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(".github/workflows/ci.yml:8  [runner]");
    expect(result.stderr).not.toContain("ok.yml");
  });

  it("the repository's workflows pass lint:workflows", async () => {
    const dir = join(repo, ".github", "workflows");
    const names = (await readdir(dir)).filter((name) => /\.ya?ml$/.test(name));
    const files = await Promise.all(
      names.map(async (name) => ({ path: `.github/workflows/${name}`, text: await readFile(join(dir, name), "utf8") })),
    );

    expect(names.length).toBeGreaterThan(0);
    expect(checkWorkflows(files)).toEqual([]);
  });

  it("actionPins lists each pinned action with the tag its comment names", () => {
    const text = workflow({ jobs: job("build", { steps: `- uses: ${SETUP_NODE}\n- uses: ./.github/actions/local` }) });

    expect(actionPins(text)).toEqual([
      { repo: "actions/checkout", sha: SHA, tag: "v7.0.1", line: 13 },
      { repo: "actions/setup-node", sha: "820762786026740c76f36085b0efc47a31fe5020", tag: "v7.0.0", line: 16 },
    ]);
  });

  it("lint:workflows passes an empty workflow directory", async () => {
    const root = await tempTree("workflows-", {});
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    await writeFile(join(root, ".github", "workflows", "README.txt"), "not a workflow");

    expect((await runScript(lint, ["--root", root])).code).toBe(0);
  });
});
