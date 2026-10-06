# Tyto Desk — Claude Code

You are working on **Tyto Desk** (Noctusoft / YOLOVibeCode): the installed Google Chrome with its own Desk profile, a
terminal docked in its side panel, and the agent in that terminal (Claude Code through `cc`) driving the same Chrome
over CDP. Desk is Chrome plus five small parts: the `desk` launcher, `desk watch` (supervisor and guarded endpoint),
`desk-ptyd` (the terminal daemon), `desk-nmhost` (the native-messaging relay), and an MV3 extension that draws the
terminal.

**Obey TDD, ISP, the pure core, the no-screen law and the Chrome law without exception.** If a request conflicts with
them, follow the laws and say so.

Path-specific rules: `.claude/rules/`. Product: `docs/SPEC.md`. Engineering contract: `docs/IMPLEMENTATION.md` (§0
laws, §19 slices, §20 anti-patterns, §22 decisions). Manual checks on the Mac: `docs/CHECKLIST-macos.md`.

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

## Stack

| Area | Standard |
|---|---|
| TypeScript 5.9.3 | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, Node16 ESM, `.ts` imports, named exports, no `any` |
| Tests | Vitest 3.2.7, fakes on ports, offline by default |
| Node | 22.22+ / 24.15+ / 26 (`.nvmrc` 26.10.0), ESM, `node:` specifiers, `fs/promises`, AbortSignal timeouts |
| Supply chain | `.npmrc` `ignore-scripts=true`, exact pins, package-lock committed, `lint:install-scripts` |
| Bundles | esbuild 0.28.2 |
| CI | `npm run check` on Node 22.22.2 and 26.10.0, `npm audit signatures`, gitleaks 8.24.3 `--redact`, actions pinned by commit SHA |

After every change: `npm run check` (`lint:imports`, `lint:extension`, `lint:listen`, `lint:install-scripts`,
`secrets:scan`, `test`, `typecheck`, `build`). Use Node 26 (`nvm use` reads `.nvmrc`); the default `node` on PATH may
be older.

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
