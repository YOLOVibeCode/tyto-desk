# Tyto Desk — Claude Code

You are working on **Tyto Desk** (Noctusoft / YOLOVibeCode): the installed Google Chrome with its own Desk profile, a
terminal docked in its side panel, and the agent in that terminal (Claude Code through `cc`) driving the same Chrome
over CDP. Desk is Chrome plus five small parts: the `desk` launcher, `desk watch` (supervisor and guarded endpoint),
`desk-ptyd` (the terminal daemon), `desk-nmhost` (the native-messaging relay), and an MV3 extension that draws the
terminal.

**Obey TDD, ISP, the pure core, the no-screen law and the Chrome law without exception.** If a request conflicts with
them, follow the laws and say so.

Path-specific rules: `.claude/rules/`. Product: `docs/SPEC.md`. Engineering contract: `docs/IMPLEMENTATION.md` (§0
laws, §19 slices, §20 anti-patterns, §22 decisions, §23 delivery). Manual checks on the Mac: `docs/CHECKLIST-macos.md`.
Branches, pull requests and the rules for agents: `docs/CONTRIBUTING.md`. Versions and releases: `docs/RELEASING.md`.

## TDD

- Write the failing test first. Names are spec sentences, from IMPLEMENTATION §19 where it gives them. One behavior
  per `it`; tables use `it.each`.
- `npm test` is offline: no browser, no Chrome binary, no network, no PTY, no keys.
- Live tests live in `packages/*/test/live/` and run only inside the Desk test container (`npm run test:live`, from
  slice 1b). A known gap is an `it.fails` naming its issue, never an `it.skip`.

## ISP

- One port per file in `packages/core/src/ports/`, named as the file (`port-probe.ts` → `PortProbe`).
- Separate fakes in `@desk/core/testing`, one per port (`FakePortProbe`, `MemoryConfigStore`, `SeqRandom`). No god
  port, no god fake.
- Adapters implement ports. A port that is hard to fake is the wrong port.

## Pure, browser-safe core

- `@desk/core` imports nothing from `node:*`, `child_process`, `fs`, `net`, `http`, `WebSocket`, `node-pty`,
  `@xterm/*`, `chrome.*`, Electron, Playwright, Puppeteer, or vendor LLM SDKs, and uses no `Buffer`, `process`,
  `require`, `globalThis`, browser globals (`chrome`, `window`, `document`, …), `eval`, `Function`, or triple-slash
  references.
- Its tsconfig sets `"types": []` and `"lib": ["ES2023"]`. `npm run lint:imports` and a neutral-platform esbuild
  bundle test enforce the rest. The extension bundles core, so core must run inside Chrome.

## Nothing on the operator's screen, nothing in the operator's ~/.desk

- Never launch Chrome, Electron, or any GUI app, never run anything that opens a window, and never run the installed
  `desk`. macOS-only behavior is `docs/CHECKLIST-macos.md`, which the operator runs.
- Never touch the real `~/.desk`, `~/.agent-browser`, or any browser profile.
- Every test run gets a fresh HOME, DESK_HOME and TMPDIR (`test/setup/global-setup.ts`), and fails if the real
  `~/.desk` changed. Under Vitest, Node adapters refuse paths under the real home (by spelling and by identity) and
  ports 9222, 9229 and 9400–9899 (`@desk/node`), and `guiAllowed` is false. No test listens beyond 127.0.0.1.

## Chrome law

- Desk starts the installed Chrome only through `ChromeProcess`, with arguments from `core/chrome/args.ts`.
- Never the pipe, port 0, `--enable-automation`, `--headless`, `--remote-allow-origins`, `--use-mock-keychain`,
  `--no-sandbox`, or a Playwright/Puppeteer `launch()`.
- Never write protected, syncable, or `Secure Preferences` prefs by default. Never quit Chrome with a signal: CDP
  `Browser.close`.

## Security

- Public repo: never commit `.env`, browser profiles, Desk or agent-browser state, traces, cookies, tokens, or keys.
  Tests use fake values.
- Child processes run through `execFile`/`spawn` with an argv array, never a shell string, with explicit environments
  and an `AbortSignal` timeout on every external call.
- Files under `~/.desk` are 0600 in 0700 directories, written atomically. Logs hold typed events only, and the
  `Redactor` runs on every string that reaches disk. Desk sends nothing to a model.
- Consent operations go through `Prompter` on an interactive TTY. There is no `--yes`.

## Pull requests and releases (IMPLEMENTATION §23.1; CONTRIBUTING, rules for agents)

- Work in your own worktree, on a `slice-<id>/<topic>`, `feat/…`, `fix/…`, `docs/…`, `ci/…` or `chore/…` branch from
  `origin/main`. The PR title is a Conventional Commit (`feat(slice-1c): …`, the slice id as the scope); check it with
  `node scripts/delivery/check-pr.mjs --title "<title>"` before `gh pr create`.
- Never push to `main`, never create or push a tag, never `gh pr merge --admin`, `--merge` or `--rebase`.
- Until `node scripts/delivery/github-setup.mjs` (its `--check`) is clean, never pass `--auto`: merge with
  `gh pr checks <n> --watch --fail-fast && gh pr merge <n> --squash --match-head-commit <sha>`. Afterwards,
  `gh pr merge --auto --squash` right after `gh pr create`.
- Never turn on the auto-merge of a PR labeled `owner-merge`, or remove the label. Merge one only as the agent session
  acting for the owner, with the owner's `gh`, and only after every check is green on its exact head SHA and at least
  two independent security-review agents (not its author) posted APPROVE or APPROVE_WITH_NITS verdict comments naming
  that SHA: any REFUSE blocks it, and nits become follow-ups. Merge it with
  `gh pr merge <n> --squash --match-head-commit <sha>` (IMPLEMENTATION §23.1, D81). A change to an owner-merge path
  (`scripts/delivery/owner-paths.json`: `.github/`, `scripts/delivery/`, the agent rules at any depth,
  `docs/CONTRIBUTING.md`, …) goes in its own PR.
- Never merge the release PR, mark it ready, turn its auto-merge on, or push to its branch. Never approve a deployment.
- Never edit package.json's `version`, package-lock.json's root version, `.release-please-manifest.json`, or
  `CHANGELOG.md`: release-please owns them.
- Never run `npm run deploy`, `desk update`, `desk use`, `desk rollback`, or `github-setup.mjs --apply`. `npm run pack`
  (it writes only `dist/`) and `github-setup.mjs --check` (it only reads) are fine.
- Name the signed-in `gh` account with `gh api user --jq .login`. Never print a secret.

## Stack

| Area | Standard |
|---|---|
| TypeScript 5.9.3 | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, Node16 ESM, `.ts` imports, named exports, no `any` |
| Tests | Vitest 5.0.3, fakes on ports, offline by default |
| Node | 22.22+ / 24.15+ / 26 (`.nvmrc` 26.10.0), ESM, `node:` specifiers, `fs/promises`, AbortSignal timeouts |
| Supply chain | `.npmrc` `ignore-scripts=true`, exact pins, package-lock committed, `lint:install-scripts` |
| Bundles | esbuild 0.28.2 |
| CI | `npm run check` on Node 22.22.2 and 26.10.0, `npm audit signatures`, gitleaks 8.24.3 `--redact`, actions pinned by commit SHA; required checks `pr-title` and `ci-ok` |
| Delivery | Conventional Commit PR titles, squash merges, release-please draft release PRs, attested builds (`scripts/delivery/`, IMPLEMENTATION §23) |

After every change: `npm run check` (`lint:imports`, `lint:extension`, `lint:listen`, `lint:install-scripts`,
`lint:workflows`, `secrets:scan`, `test`, `typecheck`, `build`). Use Node 26 (`nvm use` reads `.nvmrc`); the default
`node` on PATH may be older.

<!-- agent-playbook -->
## Efficient generation

**Exception to the one-door rule (the user's decision, 2026-10-06):** Desk is built interactively on this Mac, slice
by slice, because the cloud-agents farm's Linux VMs cannot run its live suite. Do not farm it, and do not start Cloud
Agents or Slack jobs for it. Changes to claude-remote-control go as a PR in that repo (IMPLEMENTATION §22 D24).

- `bc-…` → resume that agent. Never a second job.
- Never: Opus/GPT as the Cursor model, Fast on, `ANTHROPIC_API_KEY` in the shell, extra Max usage, re-farming a
  failed `bc-` job.

## Close

Last lines of every job are COST: this run, this project total, today. If cents are unknown, write `COST this run: unknown`.
<!-- /agent-playbook -->
