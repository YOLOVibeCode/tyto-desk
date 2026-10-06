# Agent instructions (Cursor, Claude Code, other coding agents)

Tyto Desk is the installed Google Chrome with a terminal docked in its side panel, and the agent in that terminal
driving the same Chrome over CDP. It is **TDD + ISP** with a pure, browser-safe core. Detailed rules:
[`.claude/rules/`](.claude/rules/); Claude Code also reads [`CLAUDE.md`](./CLAUDE.md).

## Non-negotiable

1. **Red–green–refactor.** A failing spec-sentence test exists before production code (names from
   `docs/IMPLEMENTATION.md` §19). One behavior per `it`; tables use `it.each`.
2. **`npm test` is offline.** No browser, no Chrome, no network, no PTY, no keys. Live tests run only inside the Desk
   test container.
3. **No god interfaces.** One port per file in `packages/core/src/ports/`; separate fakes in `@desk/core/testing`.
4. **`@desk/core` is pure and browser-safe.** No Node builtins or globals, no I/O, no browser drivers, no `chrome.*`.
5. **Nothing on the operator's screen, nothing in the operator's `~/.desk`.** Never launch Chrome or any GUI app,
   never run the installed `desk`, never touch `~/.desk`, `~/.agent-browser`, or a browser profile.
6. **Chrome law.** Arguments only from `core/chrome/args.ts`; no automation flags; quit with CDP `Browser.close`,
   never a signal.
7. **No secrets in git, logs, or files Desk writes.** Child processes take argv arrays, never shell strings.
8. **Never re-implement agent-browser.**
9. After changes: `npm run check`.

Full contract: [docs/IMPLEMENTATION.md](./docs/IMPLEMENTATION.md). Desk is built interactively on the operator's Mac
(the user's 2026-10-06 exception to the one-door rule): no farm, no Cloud Agents or Slack job.
