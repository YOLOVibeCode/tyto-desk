# Releasing Tyto Desk

The contract is [IMPLEMENTATION §23](./IMPLEMENTATION.md#23-delivery-branches-versions-deploy-paths-releases); this
page is the runbook. Pull requests merge themselves when their checks pass, except changes to the pipeline and the
agent rules, which you merge, or your agent session merges for you by your rule (IMPLEMENTATION D81: every check green
on the exact head SHA and two independent security reviews of the full diff of every owner-merge path; a REFUSE stops
the merge until a later review resolves it, and the session tells you why). release-please keeps a draft release PR
open. When you want a release, you read what changed and merge that PR; CI builds and tests it, then waits for you to
approve publication; your Mac takes it with `desk update`.

> **TL;DR**
>
> 1. Land work as PRs titled with Conventional Commits (`feat(slice-1c): …`, `fix: …`). They merge themselves once
>    `pr-title` and `ci-ok` pass; a PR labeled `owner-merge` waits for you, or for your agent session once every check
>    is green on its exact head SHA and two independent security reviews of its full owner-merge diff approved that
>    SHA, with no REFUSE left unresolved (D81).
> 2. release-please keeps a draft `chore(main): release X.Y.Z` open with the changelog, and the live suite runs on it.
>    When you want the release, read what changed (pre-flight), then
>    `gh pr ready <n> && gh pr merge <n> --squash --match-head-commit <sha>`.
> 3. `release.yml` builds on macOS arm64 and runs the live suite, then waits for your approval of `publish`; it then
>    attests the assets, attaches them to the draft release, and publishes it. Published releases are immutable. Allow
>    about 30 minutes.
> 4. On your Mac: `desk update`. A bad release: `desk rollback`.

---

## The four release rules

### Rule 1 — Every commit on `main` is a Conventional Commit

Squash merges make the PR title the commit title and the PR body its body, and `pr-title` refuses anything else.
release-please opens or updates the release PR whenever its changelog would gain an entry.

| Prefix | Meaning | Release |
|---|---|---|
| `feat:` | a capability you can use | proposes one: patch before 1.0, minor from 1.0 |
| `fix:` | a bug fix; Dependabot's runtime updates (`fix(deps):`) | proposes one: patch |
| `perf:` · `refactor:` · `revert:` | faster, restructured, reverted | proposes one: patch |
| `feat!:`, or a `BREAKING CHANGE:` footer in the PR body | a breaking change | proposes one: minor before 1.0, major from 1.0 |
| `docs:` · `test:` · `build:` · `ci:` · `chore:` | documents, tests, build, workflows, tooling | hidden from the changelog; proposes none |

A slice's PR names the slice as its scope: `feat(slice-1c): one shell, one agent, in the left panel`. The first release
is 0.1.0; 1.0.0 comes after checklist Run B passes (slice 8), through a `Release-As: 1.0.0` footer in that PR's body.

### Rule 2 — Run `npm run check` before pushing

It runs the lints, the secret scan, the tests, the type check, and the build, as CI does. Agents also run
`npm run pack` to see the runtime build; only you run `npm run deploy`.

### Rule 3 — Never push to `main`, never push a tag, never `--admin`

The `main` ruleset takes pull requests only, and no ruleset has a bypass actor, so `--admin` fails for you too. Only
the Desk Release App creates tags and writes the release PR's branch. Every change, a hot fix included, goes through a
PR. Until the repository settings are applied (one-time setup, step 1), nobody merges with `--auto`
([CONTRIBUTING](./CONTRIBUTING.md#open-a-pull-request)).

### Rule 4 — Never edit the version or the changelog by hand

release-please owns the root package.json's `version`, package-lock.json's root version,
`.release-please-manifest.json`, and `CHANGELOG.md`, and changes them only in the release PR. To force a version, put a
`Release-As: X.Y.Z` footer in a PR's body.

---

## Pipeline

```
 feat/fix PRs ──auto-merge──▶ main ──push──▶ release-please.yml (the release App's token)
                                              │ opens or updates the draft PR "chore(main): release X.Y.Z",
                                              │ labeled live; CI and the live suite run on it
                                              ▼
                       you read what changed, mark the PR ready, and merge it
                                              │
                                              ▼
                  release-please: a draft release vX.Y.Z and its tag
                                              │ the tag starts release.yml
                                              ▼
  plan ─▶ build (macos-26) ─▶ live suite (ubuntu-24.04-arm) ─▶ publish, once you approve:
                                                               check sha256, attest, upload to the draft,
                                                               check the assets, publish (immutable) ─▶ verify
                                              │
                                              ▼
                              your Mac: desk update (a fresh Mac: install.sh)
```

| Channel | Built from | Version | Goes to | Installed with |
|---|---|---|---|---|
| stable | a `v*` tag | `0.3.0` | a published, immutable GitHub release | `desk update`, `install.sh` |
| edge | every push to `main` that is not docs-only | `0.3.1-edge.57+a1b2c3d` | an attested workflow artifact, 30 days | `desk update --channel edge` |
| pr | every PR that changes code | `0.3.1-pr.42.118+a1b2c3d` | a workflow artifact, 7 days | nothing; it proves the build |
| dev | your checkout | `0.3.1-dev.slice-1c-walking-skeleton+a1b2c3d` | your Mac | `npm run deploy` |
| dry run | `release.yml` run on `main` | `0.3.0+dryrun.12` | a workflow artifact, 1 day | nothing; it rehearses a release |

Agent PRs merge without review, so an edge build is whatever `main` holds; its provenance proves where it was built,
not that anyone read it. A stable release is the version you read and chose to cut.

---

## Per-release runbook

### Pre-flight

- [ ] Slices 1c and D2 have merged. Before 1c there is no runtime to release, and before D2 no `install.sh`, which
      `publish` requires; until both, the release PR's `ci-ok` stays red and `release.yml`'s `plan` refuses, on
      purpose (IMPLEMENTATION D58, D67).
- [ ] CI on `main` is green: `gh run list --workflow ci.yml --branch main --limit 1`.
- [ ] Find the release PR, a draft: `gh pr list --label "autorelease: pending"`.
- [ ] Read what changed since the last release, not only the changelog: release-please writes it from PR titles and
      from override blocks that any PR body can carry. Replace `vPREV` with the last release's tag (for the first
      release, drop `vPREV..` and read the whole history):

  ```bash
  git fetch origin --tags
  git log --oneline vPREV..origin/main
  git diff --stat vPREV..origin/main -- .github scripts/delivery packages/core/src/release \
    scripts/allowed-install-scripts.json .npmrc .gitleaks.toml scripts/lib/secrets.mjs package.json \
    package-lock.json release-please-config.json docs/CONTRIBUTING.md \
    ':(glob,icase)**/CLAUDE.md' ':(glob,icase)**/CLAUDE.local.md' ':(glob,icase)**/AGENTS.md' \
    ':(glob,icase)**/AGENTS.override.md' ':(glob,icase)**/.claude/**' ':(glob,icase)**/.cursor/**' \
    ':(glob,icase)**/.cursorrules' ':(glob,icase)**/.mcp.json' ':(glob,icase)**/.gitattributes'
  git -c core.quotePath=false diff --name-only vPREV..origin/main | LC_ALL=C grep '[^ -~]'
  ```

  Those are the owner-merge paths (`scripts/delivery/owner-paths.json`; the agent rules count at any depth) and the
  package files. `icase` folds ASCII letters only, while owner-merge folds names as macOS reads them (NFKC, then
  without case, D82), so the last command lists every changed path with a character outside ASCII: read each as an
  owner-merge path too. Read every change to them in full (`git diff vPREV..origin/main -- <path>`) before you merge,
  those your agent session merged after its reviews (D81) included.
- [ ] Read its `CHANGELOG.md` diff. A wrong section or a missing entry means a merged PR's title was wrong: add a
      `BEGIN_COMMIT_OVERRIDE` … `END_COMMIT_OVERRIDE` block with the right Conventional Commit to that merged PR's
      body, then `gh workflow run release-please.yml`. Never edit the changelog in the release PR.
- [ ] Its checks are green, the live suite included: `gh pr checks <n>`.

### Cut

- [ ] Mark it ready and merge it, naming the commit you reviewed:
      `gh pr ready <n> && gh pr merge <n> --squash --match-head-commit <sha>`.
- [ ] release-please creates the draft release `vX.Y.Z` and its tag; the tag starts `release.yml`:
      `gh run watch $(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')`.

### Approve publication

- [ ] When `build` and `live` are green, the run waits for the `publish` environment. Look at the run, then approve it
      in the web UI (Review deployments → publish → Approve and deploy), or:

  ```bash
  run=<run-id>
  env=$(gh api repos/YOLOVibeCode/tyto-desk/environments/publish --jq .id)
  gh api -X POST "repos/YOLOVibeCode/tyto-desk/actions/runs/$run/pending_deployments" \
    -F "environment_ids[]=$env" -f state=approved -f comment="release vX.Y.Z"
  ```

  Only you approve a deployment; agents never do.

### Verify

- [ ] `verify` passed. The release is published and immutable:
      `gh release verify vX.Y.Z --repo YOLOVibeCode/tyto-desk`.
- [ ] Its assets are `desk-X.Y.Z-darwin-arm64.tar.gz`, `install.sh`, and `SHA256SUMS`:
      `gh release view vX.Y.Z --repo YOLOVibeCode/tyto-desk`.

### Take it

- [ ] On your Mac, in Termius: `desk update`, confirm, then `desk`. `desk --version` names `X.Y.Z`; your panes and
      tmux sessions are still there.

### Rehearse

`gh workflow run release.yml --repo YOLOVibeCode/tyto-desk --ref main` runs `plan`, the macOS build, and the live suite
as a stable-shaped dry run and stops before any tag, release, or attestation. Run it once before the first release
and after any change to the release path.

---

## If something goes wrong

| Symptom | Action |
|---|---|
| No release PR | Only a `feat`, `fix`, `perf`, `refactor`, or `revert` commit, or a breaking change, proposes one. Or the release App is missing: `release-please.yml`'s run says so (one-time setup, below) |
| The release PR's checks are red | Fix it on `main` in a PR; release-please updates its PR. Before slices 1c and D2, `ci-ok` is red on purpose: it names the missing runtime or installer |
| The release PR merged, but there is no `vX.Y.Z` tag or draft | `release-please.yml` failed (the App's token, an outage): `gh workflow run release-please.yml` |
| `release.yml` failed in `plan` | It names the refusal: a tag off `main`, a version that differs from package.json, or no runtime (slice 1c) or installer (slice D2) yet |
| `publish` failed: no release for the tag | release-please drafts the release with its tag; if it did not, `gh workflow run release-please.yml`, then re-run the failed jobs |
| `release.yml` failed in build, live, publish, or verify for a passing reason (runner, network, Sigstore) | `gh run rerun <run-id> --failed`. The draft and its tag wait. `publish` resumes: a release an earlier attempt already published with matching assets goes straight to `verify` |
| The live suite failed because Google pruned the pinned Chrome | Bump the pin in a PR (IMPLEMENTATION §17.3), leave that tag a draft, and release the next patch. The release PR's own live run normally catches this first |
| `release.yml` failed because of the code | Fix forward: a `fix:` PR, then merge the next release PR (X.Y.Z+1). The failed version stays an unpublished draft that nothing installs; delete the draft in the web UI if you like. Its tag stays, and nobody moves it |
| `verify` failed after the release was published | Run its commands by hand to see why. If the release itself is wrong, `gh release edit vX.Y.Z --prerelease` and ship the next patch |
| `release.yml` did not start after the merge | `gh workflow run release.yml --ref vX.Y.Z` |
| A published release is bad | `gh release edit vX.Y.Z --prerelease` takes it out of `releases/latest` (its assets stay); `desk rollback` on your Mac; ship the fix as the next patch |
| `desk update` refuses the provenance | Install nothing. Read the `gh attestation verify` output it shows, and check that `gh --version` is 2.102.0 or later |
| `main` is red after a merge | Fix forward in a PR. If GitHub itself is broken, you, never an agent, may set a ruleset's enforcement to `disabled` in the web UI, and back afterwards |

## Tags and releases are immutable

A published release's assets and tag never change, and its tag name can never be used again, even after the release is
deleted (immutable releases). The `tags` ruleset also stops anyone but the release App from creating, moving, or
deleting any tag. So there is one way to correct a release: the next version.

## Hot fixes

There are no release branches in v1: `main` is releasable after every merge. Land the fix as a `fix:` PR, then merge
the release PR it updates.

## Rollback

On your Mac, `desk rollback` returns to the previous version and `desk use <version>` to any installed one; neither
stops a shell. `desk versions` lists what is installed. Neither crosses a state-schema change: Desk refuses and names
the file. `desk update` never moves to an older version on its own.

---

## One-time setup

### 1. Repository settings (once slice D1 has merged)

```bash
node scripts/delivery/github-setup.mjs            # --check: prints desired and actual, changes nothing
node scripts/delivery/github-setup.mjs --apply    # asks, then applies only what differs
```

It sets squash-only merges with the PR title and body as the commit, auto-merge, branch deletion, the Actions policy
(GitHub-owned actions plus two named ones, full-SHA pinning, a read-only `GITHUB_TOKEN`, approval before any outside
contributor's PR runs workflows), immutable releases, secret scanning with push protection, Dependabot alerts and
security updates, the `release-please` and `publish` environments (you as `publish`'s required reviewer), the `live`
and `owner-merge` labels, and the `main`, `tags`, and `release branch` rulesets. Run it as soon as D1 has merged:
until then no check is required, every PR merges by the interim rule
([CONTRIBUTING](./CONTRIBUTING.md#open-a-pull-request)), and Dependabot, which starts the moment `dependabot.yml` is on
`main`, gets a comment instead of auto-merge on every PR, even an allowed dev-tool patch (`dependabot-auto-merge.yml`
turns auto-merge on only once `main` requires `pr-title` and `ci-ok`). Merge those by hand by the interim rule, or,
after `--apply`, comment `@dependabot rebase` on each so the workflow runs again. Right after `--apply`, rebase every
PR that was open before D1 merged onto `main` (or merge `main` into it): `pr-title` checks the workflow files at a
PR's head, so a branch from before D1 fails it until its head carries D1's workflows. Run `--check` whenever you
wonder whether a setting drifted.

### 2. The Desk Release App

release-please needs an identity whose pull requests and tags start workflows, which `GITHUB_TOKEN`'s never do; the
`tags` and `release branch` rulesets let only this App through.

1. YOLOVibeCode → Settings → Developer settings → GitHub Apps → New GitHub App. Name it (for example
   `tyto-desk-release`), turn the webhook off, and grant repository permissions Contents: read and write, Pull requests:
   read and write, Issues: read and write (Metadata: read is automatic). Nothing else. Only this account may install it.
2. Generate a private key. Store the downloaded `.pem` in 1Password (vault Projects), then delete the file:
   `rm ~/Downloads/<app>.*.private-key.pem`. `rm` does not wipe it (`rm -P` does nothing on current macOS), so if Time
   Machine or a sync service may have copied the file, generate a new key and delete this one in the App's settings.
3. Install the App on `YOLOVibeCode/tyto-desk` only.
4. Give the `release-please` environment the client id (not a secret) and the key (never printed):

   ```bash
   gh variable set RELEASE_APP_CLIENT_ID --env release-please --repo YOLOVibeCode/tyto-desk --body <client id>
   k=$(op read "op://Projects/<item-id>/private key") \
     && printf '%s' "$k" | gh secret set RELEASE_APP_PRIVATE_KEY --env release-please --repo YOLOVibeCode/tyto-desk; unset k
   ```

   `printf` is a shell builtin, so the key never appears in a process listing; prove it worked with
   `gh secret list --env release-please --repo YOLOVibeCode/tyto-desk`, which shows names only.

5. Set the App's slug in `scripts/delivery/github-setup.mjs` (a PR you merge), then run
   `node scripts/delivery/github-setup.mjs --apply`: the `tags` and `release branch` rulesets get the App as their
   only bypass actor.

To rotate the key: generate a new one, repeat step 4, then delete the old key in the App's settings.

### 3. A token for agents (recommended)

Agents work through your `gh`, so GitHub cannot tell them from you: the owner-merge rule and the release PR's draft
state hold only as long as agents follow their rules (IMPLEMENTATION §22, D50 and D51). A fine-grained token narrows
what they can do:

1. GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token. Resource owner YOLOVibeCode;
   repository access: only `tyto-desk`; permissions: Contents read and write, Pull requests read and write, Actions
   read (Metadata read is automatic). Nothing else: no Workflows, Administration, Environments, Secrets, Variables,
   or Deployments. Approve it as the organization's owner if GitHub asks.
2. Store it in 1Password and give it to agent sessions as `GH_TOKEN`, read straight into the environment of the shell
   that starts the agent (`export GH_TOKEN="$(op read "op://Projects/<item-id>/token")"`), never into a file.

With it, agents still open PRs and turn on auto-merge, but cannot push a workflow change, change a setting or a
ruleset, read a secret, or approve a release. You push workflow changes yourself, slice D1's included.

### 4. Signed and notarized builds (later, if wanted)

v1 signs Desk Terminal ad hoc, which is enough on your own Mac. To ship Desk to other Macs, create a `signing`
environment (deployments from `v*` tags only, you as required reviewer) and add YOLOTerm's signing secrets to it, never
to the repository or another environment: `MACOS_CERTIFICATE` (base64 of the Developer ID Application `.p12`),
`MACOS_CERTIFICATE_PWD`, `KEYCHAIN_PASSWORD`, `NOTARIZATION_APPLE_ID`, `NOTARIZATION_TEAM_ID`, `NOTARIZATION_PASSWORD`
(an app-specific password). A dedicated `sign` job then signs Desk Terminal with the hardened runtime, notarizes it,
and staples the ticket before `publish`, and runs nothing else (IMPLEMENTATION §23.10).
