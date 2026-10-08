# agent-browser: config keys that command-line flags cannot override

Draft for an issue in vercel-labs/agent-browser (Desk slice 4c, docs/IMPLEMENTATION.md §11, §22 D22). Not filed yet.

## What happens

An embedder points agents at a config file with `AGENT_BROWSER_CONFIG` (Desk: `cdp` at its guarded endpoint,
`restoreSave: "never"`, `actionPolicy`). Global flags on the command line override those keys (`--cdp`,
`--auto-connect`, `--restore`, `--session-name`, `--state`, `--profile`, `--namespace`, `--action-policy`,
`--config`), and they are taken from anywhere in the arguments (`clean_args` in `flags.rs`). An agent whose commands a
web page steers can add one to a command its host pre-approved, and leave the browser, the state, or the policy the
embedder chose.

## Asked

A config key that makes chosen keys authoritative, for example `"lockedKeys": ["cdp", "restoreSave", "actionPolicy"]`
or `"allowFlagOverrides": false`: a flag that would change a locked key is refused with an error naming it, and the
command does not run.
