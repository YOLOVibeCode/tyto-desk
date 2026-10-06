# Node packages (adapters)

Node 22.22+ / 24.15+ / 26 (`.nvmrc` 26.10.0), ESM, `node:` specifiers, `fs/promises` (no sync I/O in adapters).

- Spawn `agent-browser`, `tmux`, `ps`, `lsof`, `codesign`, `launchctl` and `open` with `execFile`/`spawn` and an argv
  array, never a shell string, with an explicit environment.
- Every external call has a timeout via `AbortSignal` (IMPLEMENTATION §6.6). Never `sleep` as a success condition.
- Files under `~/.desk` are 0600 in 0700 directories, written atomically with `writePrivate` (temp file + rename).
- Adapters take explicit roots (never `os.homedir()` inside an adapter) and call the `@desk/node` guard before touching
  a path or a port.
- Children never inherit `NODE_OPTIONS`, `NODE_PATH`, `NODE_REPL_EXTERNAL_MODULE`, or `ANTHROPIC_API_KEY`.
