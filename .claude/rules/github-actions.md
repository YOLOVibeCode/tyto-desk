# GitHub Actions

- Top-level `permissions: {}`; each job asks for the scopes it needs (`contents: read` for most; write scopes only where
  IMPLEMENTATION §23.7 gives them). Every action pinned to a commit SHA, with its tag (never a branch or a commit) in a
  comment; look SHAs up with `gh api`; no local action in a step. `persist-credentials: false` on checkout.
- `npm ci --ignore-scripts`, `npm audit signatures`, then the `npm run check` steps on Node 22.22.2 and 26.10.0.
- Gitleaks 8.24.3 with `--redact`, tarball sha256-verified before use, no path allowlist. Never echo secrets.
- Default CI never installs a browser or agent-browser. The live suite (`live.yml` through `live-run.yml`,
  IMPLEMENTATION §18) runs weekly, on `workflow_dispatch`, on same-repository PRs labeled `live` (the release PR always
  is), and as `release.yml`'s gate, with no secrets and never on fork PRs.
- `npm run lint:workflows` (IMPLEMENTATION §23.7) holds every rule; `main`'s `pr-title` applies it to a PR's workflows.
