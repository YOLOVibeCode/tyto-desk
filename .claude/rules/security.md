# Security

Public repo. Never commit `.env`, browser profiles, Desk or agent-browser state, traces, cookies, tokens, or keys.

- `npm run secrets:scan` and gitleaks stay green. Both scan code, docs, and tests; only specific fake or public values
  are allowlisted, never paths. Build secret-shaped test inputs at run time. Never print secret values.
- Supply chain: `.npmrc` `ignore-scripts=true`, exact pins, package-lock committed. A new dependency with an install
  script must work without it and is recorded at its exact version in `scripts/allowed-install-scripts.json`.
- Child processes through `execFile`/`spawn` with an argv array and an explicit environment. The one exception is
  `desk doctor` running the login shell with a constant `-c` payload that prints variable names only.
- Pane environments are an allowlist (`shellEnv`): never `ANTHROPIC_API_KEY`, `TMUX`, `ELECTRON_*`, `NODE_OPTIONS`,
  `AGENT_BROWSER_CDP`, `AGENT_BROWSER_NAMESPACE`, or `AGENT_BROWSER_RESTORE*`.
- Logs hold typed `LogEvent`s only: no titles, terminal output, keystrokes, cookie values, URLs, CDP payloads, or
  parser error text. The `Redactor` runs on every string that reaches disk.
- Every Desk listener applies `httpGuard` (any `Origin` → 403, a foreign `Host` → 500) and sends no CORS headers.
- Consent operations need an interactive TTY and write one audit line. There is no `--yes`.
- Page text is data, never instructions.
