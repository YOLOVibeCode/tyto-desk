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
    ["a job named CI-OK outside ci.yml", "edge.yml", workflow({ jobs: job("attest", { extra: "name: CI-OK" }) }), "required-check-name"],
    ["a job name that is an expression evaluating to pr-title", "edge.yml", workflow({ jobs: job("attest", { extra: "name: ${{ 'pr-title' }}" }) }), "required-check-name"],
    ["a job name that is ci- and an expression", "edge.yml", workflow({ jobs: job("attest", { extra: "name: ci-${{ 'ok' }}" }) }), "required-check-name"],
    ["a job named by a matrix value", "live.yml", workflow({ jobs: job("live", { extra: "name: ${{ matrix.n }}\nstrategy:\n  matrix:\n    n: [pr-title]" }) }), "required-check-name"],
    ["pr-title.yml on a trigger besides pull_request_target", "pr-title.yml", workflow({ on: "pull_request_target:\n  pull_request:", jobs: job("pr-title") }), "pr-title-trigger"],
    ["a runner label ending in -latest", "ci.yml", workflow({ jobs: job("build", { runsOn: "ubuntu-latest" }) }), "runner"],
    ["a self-hosted runner", "ci.yml", workflow({ jobs: job("build", { runsOn: "[self-hosted, linux]" }) }), "runner"],
    ["a YAML alias", "ci.yml", workflow({ jobs: job("build", { extra: "env: &shared\n  A: b" }) + "\n" + job("other", { extra: "env: *shared" }) }), "yaml-alias"],
    ["a %YAML directive, which turns on: into true:", "ci.yml", `%YAML 1.1\n---\n${workflow({ on: "pull_request_target:" })}`, "yaml-directive"],
    ["a %TAG directive", "ci.yml", `%TAG !x! tag:example.com,2026:\n---\n${workflow()}`, "yaml-directive"],
    ["an explicit YAML tag", "ci.yml", workflow({ jobs: job("build").replace("runs-on: ubuntu-24.04", "runs-on: !!str ubuntu-24.04") }), "yaml-tag"],
    ["no on key", "ci.yml", ["name: x", "permissions: {}", "jobs:", job("build"), ""].join("\n"), "on-key"],
    ["an on key that names no trigger", "ci.yml", workflow({ on: "{}" }), "on-key"],
    ["a local action in a step", "ci.yml", workflow({ jobs: job("build", { steps: "- uses: ./.github/actions/x" }) }), "local-action"],
    ["a reusable workflow outside .github/workflows", "ci.yml", workflow({ jobs: "  build:\n    uses: ./scripts/build.yml\n    permissions:\n      contents: read" }), "local-action"],
    [
      "a pull_request_target workflow that calls a reusable workflow",
      "pr-title.yml",
      workflow({
        on: "pull_request_target:",
        jobs: `${job("pr-title")}\n  build:\n    uses: ./.github/workflows/build-darwin.yml\n    permissions:\n      contents: read\n    with:\n      ref: \${{ github.event.pull_request.head.sha }}`,
      }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that fetches the pull request with git -C",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: '- run: git -C . fetch origin "pull/$PR/head"' }) }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that fetches the pull request through env",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: '- run: env GIT_TERMINAL_PROMPT=0 git --no-pager fetch origin "pull/$PR/head"' }) }),
      "pull-request-target",
    ],
    ["npm ci with --ignore-scripts false", "ci.yml", workflow({ jobs: job("build", { steps: "- run: npm ci --ignore-scripts false" }) }), "ignore-scripts"],
    ["npm ci with --no-ignore-scripts after --ignore-scripts", "ci.yml", workflow({ jobs: job("build", { steps: "- run: npm ci --ignore-scripts --no-ignore-scripts" }) }), "ignore-scripts"],
    [
      "a mixed-case checkout without persist-credentials false",
      "ci.yml",
      workflow({ jobs: job("build", { steps: `- uses: ${CHECKOUT.replace("actions/checkout", "Actions/Checkout")}\n  with:\n    fetch-depth: 0` }) }),
      "persist-credentials",
    ],
    [
      "a mixed-case cache in a pack job",
      "build-darwin.yml",
      workflow({ jobs: job("pack", { steps: `- uses: ${CACHE.replace("actions/cache@", "Actions/Cache/restore@")}\n  with:\n    path: x\n    key: y` }) }),
      "cache",
    ],
    [
      "a mixed-case setup-node cache in a publish job",
      "release.yml",
      workflow({ jobs: job("publish", { extra: "environment: publish", steps: `- uses: ${SETUP_NODE.replace("actions/setup-node", "ACTIONS/setup-node")}\n  with:\n    cache: npm` }) }),
      "cache",
    ],
    ["a file that does not parse", "ci.yml", "on: [push\njobs: {", "parse"],
    // D84: a cache in any job that holds a secret, an environment, the App's token or a write scope.
    [
      "a cache in a job with an environment",
      "release-please.yml",
      workflow({ jobs: job("release-please", { extra: "environment: release-please", steps: `- uses: ${CACHE}\n  with:\n    path: x\n    key: y` }) }),
      "cache",
    ],
    [
      "a cache in a job with a secret",
      "release-please.yml",
      workflow({
        jobs: job("release-please", {
          extra: "environment: release-please",
          steps: `- uses: ${CACHE.replace("actions/cache@", "actions/cache/restore@")}\n  with:\n    path: x\n    key: y\n- run: echo hi\n  env:\n    KEY: \${{ secrets.RELEASE_APP_PRIVATE_KEY }}`,
        }),
      }),
      "cache",
    ],
    [
      "a cache in a job with the App's token",
      "release-please.yml",
      workflow({ jobs: job("release-please", { steps: `- uses: ${APP_TOKEN}\n- uses: ${CACHE.replace("actions/cache@", "actions/cache/save@")}\n  with:\n    path: x\n    key: y` }) }),
      "cache",
    ],
    [
      "a cache in a job with a write scope",
      "dependabot-auto-merge.yml",
      workflow({ jobs: job("automerge", { steps: `- uses: ${CACHE}\n  with:\n    path: x\n    key: y` }).replace("contents: read", "contents: write") }),
      "cache",
    ],
    [
      "setup-node's cache in a job with an environment",
      "release-please.yml",
      workflow({ jobs: job("release-please", { extra: "environment:\n  name: release-please\n  deployment: false", steps: `- uses: ${SETUP_NODE}\n  with:\n    cache: npm` }) }),
      "cache",
    ],
    // D84: no shell that traces its commands in such a job, however the shell is named.
    [
      "a workflow's defaults.run.shell with -x, when a job holds a write scope",
      "release.yml",
      workflow({
        top: "permissions: {}\ndefaults:\n  run:\n    shell: bash -x {0}",
        jobs: job("publish", { extra: "environment: publish" }).replace("contents: read", "contents: write"),
      }),
      "debug-output",
    ],
    [
      "a job's defaults.run.shell with -ex in a job with an environment",
      "release-please.yml",
      workflow({ jobs: job("release-please", { extra: "environment: release-please\ndefaults:\n  run:\n    shell: bash -ex {0}" }) }),
      "debug-output",
    ],
    [
      "a step shell with -x in a job with a secret",
      "release-please.yml",
      workflow({ jobs: job("release-please", { extra: "environment: release-please", steps: "- run: echo hi\n  shell: bash --noprofile --norc -eox pipefail {0}\n  env:\n    KEY: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}" }) }),
      "debug-output",
    ],
    [
      "a step shell with -o xtrace in a job with a write scope",
      "edge.yml",
      workflow({ jobs: job("attest", { steps: "- run: echo hi\n  shell: bash -o xtrace {0}" }).replace("contents: read", "contents: read\n      id-token: write") }),
      "debug-output",
    ],
    [
      "SHELLOPTS=xtrace in a job with a write scope",
      "edge.yml",
      workflow({ jobs: job("attest", { extra: "env:\n  SHELLOPTS: braceexpand:xtrace" }).replace("contents: read", "contents: read\n      id-token: write") }),
      "debug-output",
    ],
    // D84: a pull_request_target workflow brings nothing of the pull request onto the runner, by any route.
    [
      "a pull_request_target workflow that clones a repository with gh",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: '- run: gh repo clone "$HEAD_REPO" pr -- --depth 1' }) }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that downloads a tarball with gh api",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: '- run: gh api "repos/$REPO/tarball/$HEAD_SHA" > pr.tgz' }) }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that downloads a zipball with gh api",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: '- run: gh api --method GET "repos/$REPO/zipball/$HEAD_SHA" > pr.zip' }) }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that downloads an archive with curl",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: '- run: curl -sSfL -o pr.tgz "https://codeload.github.com/$REPO/tar.gz/$HEAD_SHA"' }) }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that fetches a pull request ref with git fetch-pack",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: '- run: git fetch-pack "$URL" "refs/pull/$PR/head"' }) }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that fetches a pull request ref inside bash -c",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: `- run: bash -c "git fetch origin pull/\${PR}/head"` }) }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that names a pull request ref to any command",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: '- run: |\n    "$GIT" fetch origin "+refs/pull/*/head:refs/remotes/pr/*"' }) }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that clones a repository with gh inside sh -c",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: `- run: env GH_PROMPT_DISABLED=1 sh -c 'gh repo clone "$HEAD_REPO"'` }) }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that fetches with git inside eval",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: `- run: eval "git fetch origin \$HEAD_REF"` }) }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that clones a fork with gh repo fork --clone",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: '- run: gh repo fork "$HEAD_REPO" --clone' }) }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that updates every remote",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: "- run: git remote add pr \"$HEAD_URL\" && git remote update" }) }),
      "pull-request-target",
    ],
    // D84: nor as a diff or patch to apply, a raw file, or an API path the lint cannot read.
    [
      "a pull_request_target workflow that downloads the pull request's diff with gh pr diff",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: '- run: gh pr diff "$PR" > pr.diff' }) }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that applies a diff with git apply",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: "- run: git apply --index pr.diff" }) }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that applies patches with git am",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: "- run: git -C . am --3way < pr.patch" }) }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that applies a diff with patch -p1",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: "- run: patch -p1 < pr.diff" }) }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that pipes gh pr diff into git apply inside bash -c",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: `- run: bash -c 'gh pr diff "$PR" | git apply'` }) }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that downloads a file from raw.githubusercontent.com",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: '- run: curl -sSfLO "https://raw.githubusercontent.com/$HEAD_REPO/$HEAD_SHA/package.json"' }) }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that downloads a raw file through github.com",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: '- run: wget -q "https://github.com/$HEAD_REPO/raw/$HEAD_SHA/install.sh"' }) }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that downloads a raw file through a github.com ?raw= link",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: '- run: curl -sSfLO "https://github.com/$HEAD_REPO/blob/$HEAD_SHA/x.sh?raw=true"' }) }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that calls gh api on a path built from variables",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: '- run: gh api "repos/$REPO/$KIND/$HEAD_SHA" > pr.tgz' }) }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that calls gh api on a path built from variables, after its options",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: '- run: |\n    gh api -X GET -H "Accept: application/vnd.github.raw" --paginate "${URL}"' }) }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that calls gh api on a path a command substitution builds",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: "- run: gh api repos/YOLOVibeCode/tyto-desk/`cat kind`/main > code" }) }),
      "pull-request-target",
    ],
    [
      "a pull_request_target workflow that hands gh api a path through xargs",
      "owner-merge.yml",
      workflow({ on: "pull_request_target:", jobs: job("check", { steps: '- run: echo "repos/$REPO/pulls/$PR" | xargs gh api' }) }),
      "pull-request-target",
    ],
    // D84: no other form of tracing in a job that holds a secret, an environment or a write scope.
    [
      "a step shell that runs set -x through bash -c, in a job with a write scope",
      "edge.yml",
      workflow({ jobs: job("attest", { steps: '- run: echo hi\n  shell: bash -c "set -x; . {0}"' }).replace("contents: read", "contents: read\n      id-token: write") }),
      "debug-output",
    ],
    [
      "a step shell that runs bash -x through env -S, in a job with a write scope",
      "edge.yml",
      workflow({ jobs: job("attest", { steps: '- run: echo hi\n  shell: env -S "bash -x" {0}' }).replace("contents: read", "contents: read\n      id-token: write") }),
      "debug-output",
    ],
    [
      "bash -x through env --split-string= in a run, in a job with a write scope",
      "edge.yml",
      workflow({ jobs: job("attest", { steps: '- run: env --split-string="bash -x" ./x.sh' }).replace("contents: read", "contents: read\n      id-token: write") }),
      "debug-output",
    ],
    [
      "zsh --xtrace in a run, in a job with an environment",
      "release-please.yml",
      workflow({ jobs: job("release-please", { extra: "environment: release-please", steps: "- run: zsh --xtrace ./x.zsh" }) }),
      "debug-output",
    ],
    [
      "a job env that is an expression the rules cannot read, in a job with a write scope",
      "edge.yml",
      workflow({ jobs: job("attest", { extra: "env: ${{ fromJSON(vars.JOB_ENV) }}" }).replace("contents: read", "contents: read\n      id-token: write") }),
      "debug-output",
    ],
    [
      "BASH_ENV in a job's env, in a job with a write scope",
      "edge.yml",
      workflow({ jobs: job("attest", { extra: "env:\n  BASH_ENV: ./trace.sh" }).replace("contents: read", "contents: read\n      id-token: write") }),
      "debug-output",
    ],
    [
      "BASH_ENV in the workflow's env, when a job holds a write scope",
      "release.yml",
      workflow({ top: "permissions: {}\nenv:\n  BASH_ENV: ./trace.sh", jobs: job("publish", { extra: "environment: publish" }).replace("contents: read", "contents: write") }),
      "debug-output",
    ],
    [
      "ENV in a step's env, in a job with a secret",
      "release-please.yml",
      workflow({ jobs: job("release-please", { extra: "environment: release-please", steps: "- run: echo hi\n  env:\n    ENV: ./trace.sh\n    KEY: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}" }) }),
      "debug-output",
    ],
    [
      "SHELLOPTS from an expression, in a job with a write scope",
      "edge.yml",
      workflow({ jobs: job("attest", { extra: "env:\n  SHELLOPTS: ${{ vars.OPTS }}" }).replace("contents: read", "contents: read\n      id-token: write") }),
      "debug-output",
    ],
    [
      "bash -o xtrace in a run, in a job with a write scope",
      "edge.yml",
      workflow({ jobs: job("attest", { steps: "- run: bash -o xtrace ./scripts/x.sh" }).replace("contents: read", "contents: read\n      id-token: write") }),
      "debug-output",
    ],
    [
      "set -eo xtrace in a run, in a job with an environment",
      "release-please.yml",
      workflow({ jobs: job("release-please", { extra: "environment: release-please", steps: "- run: |\n    set -eo xtrace\n    echo hi" }) }),
      "debug-output",
    ],
    [
      "shopt -os xtrace in a run, in a job with an environment",
      "release-please.yml",
      workflow({ jobs: job("release-please", { extra: "environment: release-please", steps: "- run: shopt -os xtrace" }) }),
      "debug-output",
    ],
    [
      "setopt xtrace in a zsh run, in a job with an environment",
      "release-please.yml",
      workflow({ jobs: job("release-please", { extra: "environment: release-please", steps: "- run: setopt XTRACE\n  shell: zsh {0}" }) }),
      "debug-output",
    ],
    [
      "sh -c with set -x in a run, in a job with an environment",
      "release-please.yml",
      workflow({ jobs: job("release-please", { extra: "environment: release-please", steps: "- run: sh -c 'set -x; ./x.sh'" }) }),
      "debug-output",
    ],
    [
      "eval set -x in a run, in a job with an environment",
      "release-please.yml",
      workflow({ jobs: job("release-please", { extra: "environment: release-please", steps: '- run: eval "set -x"' }) }),
      "debug-output",
    ],
    [
      "env bash -x in a run, in a job with a write scope",
      "edge.yml",
      workflow({ jobs: job("attest", { steps: "- run: env LC_ALL=C /bin/bash -x ./x.sh" }).replace("contents: read", "contents: read\n      id-token: write") }),
      "debug-output",
    ],
    [
      "xargs bash -x in a run, in a job with a write scope",
      "edge.yml",
      workflow({ jobs: job("attest", { steps: "- run: echo ./x.sh | xargs bash -x" }).replace("contents: read", "contents: read\n      id-token: write") }),
      "debug-output",
    ],
    [
      "SHELLOPTS with xtrace written to GITHUB_ENV, in a job with a write scope",
      "edge.yml",
      workflow({ jobs: job("attest", { steps: '- run: echo "SHELLOPTS=xtrace" >> "$GITHUB_ENV"' }).replace("contents: read", "contents: read\n      id-token: write") }),
      "debug-output",
    ],
    [
      "BASH_ENV exported in a run, in a job with a write scope",
      "edge.yml",
      workflow({ jobs: job("attest", { steps: '- run: export BASH_ENV="$RUNNER_TEMP/trace.sh"' }).replace("contents: read", "contents: read\n      id-token: write") }),
      "debug-output",
    ],
  ])("lint:workflows fails on %s", (_label, file, text, rule) => {
    expect(rulesBroken(file, text)).toEqual([rule]);
  });

  it("lint:workflows allows a job name whose expression follows literal text that no required check starts with", () => {
    const text = workflow({
      jobs: job("check", { extra: 'name: check (Node ${{ matrix.node }})\nstrategy:\n  matrix:\n    node: ["22.22.2", "26.10.0"]' }),
    });

    expect(checkWorkflows([{ path: ".github/workflows/ci.yml", text }])).toEqual([]);
  });

  it("lint:workflows allows ${{ matrix.* }} and ${{ runner.* }} inside run, and expressions in env", () => {
    const text = workflow({
      jobs: job("build", {
        steps: [
          '- run: echo "${{ matrix.node }}" "${{ runner.temp }}" "$TITLE"',
          "  env:",
          "    TITLE: ${{ github.event.pull_request.title }}",
          "- run: npm --prefix packages/core ci --ignore-scripts && npm run check",
          "- run: npm ci --ignore-scripts true && npm install --ignore-scripts=true --save-dev x",
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

  it("lint:workflows allows a cache in a job that holds no secret, environment or write scope, and a shell that does not trace", () => {
    const files = [
      {
        path: ".github/workflows/live-run.yml",
        text: workflow({
          on: "workflow_call:",
          jobs: job("live", {
            runsOn: "ubuntu-24.04-arm",
            extra: "defaults:\n  run:\n    shell: bash -e {0}",
            steps: `- uses: ${CACHE.replace("actions/cache@", "actions/cache/restore@")}\n  with:\n    path: x\n    key: y\n- run: echo hi\n  shell: bash --noprofile --norc -eo pipefail {0}`,
          }),
        }),
      },
      {
        path: ".github/workflows/release.yml",
        text: workflow({
          top: "permissions: {}\ndefaults:\n  run:\n    shell: bash --noprofile --norc -euo pipefail {0}",
          jobs: job("publish", {
            extra: "environment: publish\nenv:\n  SHELLOPTS: braceexpand",
            steps: [
              "- run: |",
              "    set -euo pipefail",
              "    shopt -s nullglob dotglob",
              '    echo "NODE_ENV=production" >> "$GITHUB_ENV"',
              '    env -i PATH="$PATH" node scripts/x.mjs',
              "    bash -e ./scripts/x.sh",
              "  shell: env LC_ALL=C bash -eo pipefail {0}",
            ].join("\n"),
          }).replace("contents: read", "contents: write"),
        }),
      },
    ];

    expect(checkWorkflows(files)).toEqual([]);
  });

  it("lint:workflows allows a pull_request_target workflow to read the pull request as data: through the base's scripts, gh pr view, and gh api paths spelled out", () => {
    const text = workflow({
      on: "pull_request_target:\n    types: [opened]",
      jobs: job("owner-merge", {
        steps: [
          "- run: node scripts/delivery/owner-merge.mjs",
          '- run: gh pr view "$PR" --json files,headRefOid && gh pr comment "$PR" --body "$BODY"',
          '- run: gh pr merge --auto --squash --match-head-commit "$PR_HEAD_SHA" "$PR_URL"',
          "- run: |",
          "    gh api --method GET -H \"Accept: application/vnd.github+json\" repos/YOLOVibeCode/tyto-desk/rulesets --jq '.[].name'",
          "    gh api graphql -f query='query { viewer { login } }'",
        ].join("\n"),
      }).replace("contents: read", "contents: read\n      pull-requests: write"),
    });

    expect(checkWorkflows([{ path: ".github/workflows/owner-merge.yml", text }])).toEqual([]);
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
