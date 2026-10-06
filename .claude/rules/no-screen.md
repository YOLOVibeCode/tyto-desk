# Nothing on the operator's screen, nothing in the operator's ~/.desk (mandatory)

Desk is developed on the operator's own Mac, next to the Chrome and terminal they are using.

1. Never launch Chrome, Electron, or any GUI app, and never run anything that opens a window. Never run the installed
   `desk`. Live tests run only in the Colima VM's test container.
2. Never touch the real `~/.desk`, `~/.agent-browser`, `~/Library/Application Support/Google/Chrome`, or any browser
   profile. Reading the real Chrome profile is for `desk doctor` and confirmed imports, at run time, never in tests.
3. `guiAllowed(env, platform)` in core is the only GUI gate: false with `DESK_NO_GUI=1`, true inside the Linux test
   container (`DESK_IN_CONTAINER=1`), false whenever `VITEST` is set, otherwise true only with `DESK_ALLOW_GUI=1`, which
   only the installed `desk` launcher sets. `ChromeProcess`, `LaunchAgent`, and the Desk.app writer check it.
4. Every test run gets a fresh HOME, DESK_HOME and TMPDIR from `test/setup/global-setup.ts`, and fails if the real
   `~/.desk` changed (its `logs/` aside, which a running Desk appends to).
5. Node adapters take explicit roots and call the `@desk/node` guard: under Vitest it refuses relative paths, paths
   under the real home (also through symlinks), and ports 9222, 9229 and 9400–9899.
6. Tests signal only processes they spawned. macOS-only behavior is `docs/CHECKLIST-macos.md`, run by the operator.
