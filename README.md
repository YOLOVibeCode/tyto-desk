# Tyto Desk

Your installed Google Chrome, with its own Desk profile, a terminal docked in the side panel on the left, and the
agent you run in that terminal (Claude Code through `cc`) driving the same Chrome over the Chrome DevTools Protocol.

Status: design approved 2026-10-06; built slice by slice, test-first. Product: [docs/SPEC.md](docs/SPEC.md) ·
engineering contract: [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) · one-time Mac checks:
[docs/CHECKLIST-macos.md](docs/CHECKLIST-macos.md) · branches, pull requests and the agent rules:
[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) · versions and releases: [docs/RELEASING.md](docs/RELEASING.md).

## Develop

```bash
nvm use                               # Node 26.10.0 (.nvmrc); engines: ^22.22.2 || ^24.15.0 || >=26
npm ci --ignore-scripts               # no dependency runs an install script (.npmrc says so too)
git config core.hooksPath .githooks   # secret scan, core boundary and gitleaks before each commit
npm run check
```

`npm run check` runs `lint:imports`, `lint:extension`, `lint:listen`, `lint:install-scripts`, `lint:workflows`,
`secrets:scan`, `test`, `typecheck`, and `build`. The test suite is offline and opens nothing on your screen: no
browser, no Chrome, no PTY, no network, no keys. Each run gets a fresh HOME, DESK_HOME and TMPDIR, and fails if your
real `~/.desk` changed.

| Path | Role |
|---|---|
| `packages/core` (`@desk/core`) | Pure, browser-safe core: config, Chrome arguments, environment policy, codecs, guards, ports, and fakes (`@desk/core/testing`) |
| `packages/node` (`@desk/node`) | Shared Node adapters: private atomic files, the port probe, and the guard that keeps tests off your home and Desk's ports |
| `scripts/` | The lints, the secret scan, and the build |
| `scripts/delivery/` | The delivery pipeline: the build stamp, the PR check and workflow rules, change detection, owner-merge, the publish steps, and `github-setup.mjs` (an owner-merge path) |
| `.github/` | The workflows (CI, the PR check, edge and release builds, release-please, the live suite) and Dependabot |
| `test/` | Repo-level checks and the test-isolation setup |

Pull requests are titled as Conventional Commits and merge themselves when `pr-title` and `ci-ok` pass, except those
that change the pipeline or the agent rules, which the owner merges ([CONTRIBUTING](docs/CONTRIBUTING.md)). Releases
are cut from release-please's draft PR and published after the owner approves ([RELEASING](docs/RELEASING.md)).

Agents: read [AGENTS.md](AGENTS.md); Claude Code also reads [CLAUDE.md](CLAUDE.md).

## License

MIT. See [LICENSE](LICENSE).
