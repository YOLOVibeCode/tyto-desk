# Contributing to Tyto Desk

Desk is built slice by slice, test-first ([IMPLEMENTATION §19](./IMPLEMENTATION.md#19-slices)), mostly by coding agents
working through the operator's `gh`. The laws are in [`AGENTS.md`](../AGENTS.md) and [`CLAUDE.md`](../CLAUDE.md). The
delivery contract is
[IMPLEMENTATION §23](./IMPLEMENTATION.md#23-delivery-branches-versions-deploy-paths-releases); releases are
[`RELEASING.md`](./RELEASING.md).

## Set up

```bash
nvm use                               # Node 26.10.0 (.nvmrc)
npm ci --ignore-scripts               # no dependency runs an install script
git config core.hooksPath .githooks   # secret scan, core boundary, and gitleaks before each commit
npm run check                         # lints, secret scan, tests, type check, build: what CI runs
```

`npm test` is offline and opens nothing on your screen. `npm run pack` builds the runtime into `dist/`;
`npm run deploy` installs it on the operator's Mac and is the operator's alone (below).

## Branches

| Branch | For |
|---|---|
| `slice-<id>/<topic>` | one slice of IMPLEMENTATION §19: `slice-1c/walking-skeleton`, `slice-d1/delivery` |
| `feat/<topic>` · `fix/<topic>` | a change outside a slice |
| `docs/<topic>` · `ci/<topic>` · `chore/<topic>` | documents, workflows, tooling |

Topics are lowercase letters, digits, and hyphens, at most 50 characters. Branch from `origin/main`. `dependabot/…` and
`release-please--branches--main` belong to the bots; nobody else pushes to them.

## Pull request titles

The title becomes the commit on `main` (squash merges) and drives the version and the changelog, so `pr-title` checks
it: a Conventional Commit with a lowercase type (`feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`,
`chore`, `revert`), an optional lowercase scope, `!` for a breaking change, no trailing period, at most 72 characters.
A `slice-` branch's title names its slice as the scope.

```
feat(slice-1c): one shell, one agent, in the left panel
ci(slice-d1): delivery pipeline
fix(ptyd): keep the pane when its owner is stuck
docs: delivery plan
feat(slice-6)!: rename the toggle-key config field
```

The PR body becomes the commit body: say what changed and why, list the tests that ran by name, and say where the
slice's "Done when" stands. Put a `BREAKING CHANGE:` footer there for a breaking change.

## Open a pull request

```bash
git switch -c slice-1c/walking-skeleton origin/main
# tests first, then code; npm run check
node scripts/delivery/check-pr.mjs --title "feat(slice-1c): one shell, one agent, in the left panel"   # pr-title, locally
git push -u origin slice-1c/walking-skeleton
gh pr create --title "feat(slice-1c): one shell, one agent, in the left panel" --body-file - <<'EOF'
What changed and why. Tests that ran, by name. Where the slice's "Done when" stands.
EOF
gh pr merge --auto --squash
```

**Interim rule.** Until the owner has applied the repository settings (slice D1, then
`node scripts/delivery/github-setup.mjs --apply`; today), no check is required, and `gh pr merge --auto` merges a PR
at once, even while its checks are running or failing. Until then, never pass `--auto`; wait for the checks and name
the commit they ran on:

```bash
gh pr checks <n> --watch --fail-fast && gh pr merge <n> --squash --match-head-commit <sha>
```

Afterwards, the PR merges itself once its two required checks pass:

| Check | Workflow | What it runs |
|---|---|---|
| `pr-title` | `pr-title.yml` | from `main`'s copy of `scripts/delivery/check-pr.mjs`: the title and branch rules above, and the workflow rules on your PR's workflow files, each pinned SHA checked against its tag |
| `ci-ok` | `ci.yml` | passes when `scan` (secret scan, gitleaks) passed and, if code changed, `check` (Node 22.22.2 and 26.10.0) and `macos` (the darwin-arm64 build) passed |

A docs-only PR (`docs/`, root Markdown other than `CLAUDE.md` and `AGENTS.md`, `LICENSE`) runs only `pr-title`,
`scan`, and `ci-ok`; agent rules and package files count as code. Label a PR `live` to run the live suite on it too.
No approval is needed: GitHub never lets an author approve their own PR, and `main` requires none.

## What merges itself

| Pull request | Auto-merge |
|---|---|
| Yours or an agent's | `gh pr merge --auto --squash`, right after `gh pr create` (once the interim rule has ended) |
| One that touches an owner-merge path: `.github/`, `scripts/delivery/`, `scripts/allowed-install-scripts.json`, `.npmrc`, `.gitleaks.toml`, `scripts/lib/secrets.mjs`, the release-please config or manifest, `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.cursor/` | never: `owner-merge.yml` labels it `owner-merge` and turns auto-merge off; the operator reads the diff and merges it |
| Dependabot: a patch update of `@types/*`, `typescript`, `vitest`, or `yaml` | turned on by `dependabot-auto-merge.yml` |
| Dependabot: the weekly GitHub Actions group | never: the operator reads the new SHAs and the tags they claim, then merges it |
| Dependabot: anything else (runtime or bundled packages, esbuild, majors, the live image's base) | the operator decides |
| The release PR, `chore(main): release X.Y.Z` | never: it opens as a draft; the operator marks it ready and merges it to release |

## Rules for agents

1. Work in your own worktree, on a branch named as above. Never touch another agent's worktree, branch, or PR.
2. Tests first, named as spec sentences; `npm run check` green before every push.
3. After `gh pr create`, run `gh pr merge --auto --squash`, except under the interim rule (above) and on a PR labeled
   `owner-merge`. Never `--admin` (it fails anyway: no ruleset has a bypass actor), never `--merge` or `--rebase`.
4. Never push to `main`, never create or push a tag, and never edit package.json's `version`, package-lock.json's root
   version, `.release-please-manifest.json`, or `CHANGELOG.md`.
5. Never merge the release PR, mark it ready (`gh pr ready`), turn on its auto-merge, or push to its branch. Never
   approve a deployment: approving `publish` is the operator's release decision.
6. Never merge a PR labeled `owner-merge`, turn its auto-merge on, or remove the label. A change that needs an
   owner-merge path goes in its own PR, which says so in its body and waits for the operator.
7. Never run `npm run deploy`, `desk update`, `desk use`, `desk rollback`, the installed `desk`, or
   `scripts/delivery/github-setup.mjs --apply`: they change the operator's Mac or repository. Their prompts stop
   accidents, not a process that answers them, so this rule is what keeps you out. `npm run pack` and `github-setup.mjs`
   without `--apply` (it only reads) are fine.
8. When a check fails, fix forward on the same branch. Never skip a test, weaken a lint, or disable a check to get
   green; a known gap is an `it.fails` naming its issue.
9. Never print a secret. To see who `gh` is signed in as, run `gh api user --jq .login`, never `gh auth status`. Never
   give a secret to a workflow that runs on pull requests.
10. In a workflow, pin every action to a commit SHA with its tag in a comment
    (`gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`), set least-privilege `permissions`, and keep
    `npm run lint:workflows` green; `main`'s `pr-title` applies the same rules to your workflow files.
11. One slice, or one fix, per PR.

## Docs

A docs PR changes documents only (`docs/`, root Markdown other than `CLAUDE.md` and `AGENTS.md`), so it skips the build
jobs. Use fake values in examples (`/Users/alex`, port 9417, `a1b2c3d…`), never real tokens, cookies, or values from the
operator's Mac; the secret scan and gitleaks read docs too. Update SPEC and IMPLEMENTATION together when behavior
changes, and record deviations in IMPLEMENTATION §22.
