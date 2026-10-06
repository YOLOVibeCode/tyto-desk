# Vitest

- Tests live next to the behavior (`packages/*/test/`, repo-level checks in `test/`); names are spec sentences.
- Default suite: no browser, no Chrome, no network, no PTY, no keys. Live tests only in `test/live/` directories.
- The global setup gives each run a fresh HOME, DESK_HOME and TMPDIR; use `tmpdir()` for scratch space, never the
  checkout or the real home.
- Inject port fakes. Do not mock private methods. No god fake.
- One behavior per `it`; tables use `it.each`. No `it.skip`: a known gap is an `it.fails` naming its issue.
- No `sleep` as the success condition; use `FakeClock`.
