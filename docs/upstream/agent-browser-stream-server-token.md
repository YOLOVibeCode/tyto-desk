# agent-browser: a token (or an opt-out) for the per-session stream server

Draft for an issue in vercel-labs/agent-browser (Desk slice 4c, docs/IMPLEMENTATION.md §11, §22 D22). Not filed yet.

## What happens

Each session daemon starts a WebSocket stream server on 127.0.0.1 and writes its port to
`<socketDir>/<session>.stream`. The server accepts any connection without a credential. Any process on the machine,
and a web page that can reach `ws://127.0.0.1:<port>` (a page served from `http://localhost`, which browsers let open
loopback WebSockets), can subscribe to the session's events and send it input for the agent's tab.

## Why it matters

When agent-browser drives a signed-in browser (Desk's Chrome, or `--auto-connect` to the user's own), the stream
carries what the agent sees, and input sent to it acts with the user's logins.

## Asked

- A token: the daemon writes a random token next to the port (the `.stream` file, mode 0600) and refuses a
  connection without it, in a header or the first message; or
- a config key that turns the stream server off for embedders that do not need it (`"streamServer": false`).

`idleTimeout` already ends idle daemons, and their stream servers with them; it narrows the window but does not close it.
