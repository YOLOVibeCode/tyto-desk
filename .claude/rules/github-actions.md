# GitHub Actions

- Least-privilege `permissions` (`contents: read`). Every action pinned to a commit SHA, with its tag in a comment;
  look SHAs up with `gh api`. `persist-credentials: false` on checkout.
- `npm ci --ignore-scripts`, `npm audit signatures`, then the `npm run check` steps on Node 22.22.2 and 26.10.0.
- Gitleaks 8.24.3 with `--redact`, tarball sha256-verified before use, no path allowlist. Never echo secrets.
- Default CI never installs a browser or agent-browser. The live job (slice 1b) runs weekly and on
  `workflow_dispatch`, with no secrets and never on fork PRs.
