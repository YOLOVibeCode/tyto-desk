# Tyto Desk — Product specification

Noctusoft, Inc. · Status: draft 2 (2026-10-06), revised after the security, persistence-and-UX, and testability
review; delivery added the same day · working name "Tyto Desk", command `desk`, public repo
[`YOLOVibeCode/tyto-desk`](https://github.com/YOLOVibeCode/tyto-desk), checked out at
`/Users/admin/Dev/YOLOProjects/tyto-desk`
Engineering contract: [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) (decisions and rejected review items in its §22;
delivery in its §23) · Manual checks: [`MANUAL-CHECKS.md`](./CHECKLIST-macos.md) · Releases and contributions:
[`RELEASING.md`](./RELEASING.md), [`CONTRIBUTING.md`](./CONTRIBUTING.md) · Evidence: §10, cited as [RC], [AB], [RF],
[PA], [ST], [CR], [OR], [SP], [LAB], [VMLAB], [PROTO], [source]

## 1. What it is

Desk is one window: your installed Google Chrome, running its own Desk profile, with a terminal docked in Chrome's
side panel on the left and ordinary Chrome tabs on the right. The terminal is a real login shell. The agent you start
in it (Claude Code through your `cc` wrapper) drives that same Chrome over the Chrome DevTools Protocol.

In priority order, Desk promises:

1. **It remembers.** Logins, saved passwords, open tabs, and history survive quitting, crashes, Chrome updates, and
   Desk updates. Terminal panes come back. Claude sessions keep running in tmux while Chrome or Desk restarts.
2. **The terminal is a real terminal.** Tabs, splits, a show/focus/hide shortcut. `cc`, tmux, and Claude Remote
   Control behave as they do in Termius.
3. **Agents see everything DevTools sees.** Desk shells use a guarded endpoint that passes every CDP domain through
   and hides only the terminal itself; the raw debugging port is one command away (`desk cdp --raw`).

Desk is Chrome plus five small parts: the `desk` launcher; `desk watch`, a supervisor that also serves the guarded
endpoint; a terminal daemon that owns the shells; a native-messaging relay; and an MV3 extension that draws the
terminal. It never forks, patches, or automation-launches Chrome. A verified prototype of the panel, relay, and launch
path exists [RC, PROTO], and the Colima lab ran it on branded Chrome 155 for Linux with Chrome's sandbox on [VMLAB].

## 2. Who uses it

| Actor | Role |
|---|---|
| Operator | You. Browse, sign in, run `cc`, approve imports and installs. One person on one Mac. |
| Agent | Claude Code in tmux (via `cc`) or any CLI agent. Uses agent-browser, `tyto open/brief/find`, or any CDP client. |
| CDP clients | agent-browser ≥ 0.38.1 (primary), tyto, Puppeteer/Playwright `connectOverCDP`, chrome-devtools-mcp. They connect; they never launch Chrome. |
| Chrome | Your installed Google Chrome stable, ≥ 155, with its own user-data-dir. Google updates it as usual. |

## 3. Use cases

- **Work on a signed-in web app with an agent beside it.** The agent reads the console, network, and DOM of its own
  tab or the tab you are looking at, and acts in it; you watch in the same window. Its tabs open in the background, in
  a tab group named after its pane, and never take your keyboard.
- **A daily browser that never forgets.** Sign in to Google and your password manager once. Quit, crash, update
  Chrome or Desk: still signed in, same tabs.
- **Long Claude sessions that outlive Chrome.** Start `cc`; quit or update Chrome; the session keeps running in tmux;
  reopen Desk and the pane re-attaches. Check in from your phone with Remote Control.
- **Debug with DevTools while an agent drives the same tab.**
- **Point any CDP tool at the Desk.** `desk cdp` prints the guarded endpoint; `desk cdp --raw` the browser's own port.

## 4. Out of scope

Electron (research background only [SP, ST, CR]), a Chromium fork, Playwright/Puppeteer `launch()` of the Desk Chrome,
a visual page editor (DevTools' element picker is enough), a Windows or Linux GUI (Linux runs only Desk's test
builds), Chrome Web Store distribution, Chrome's split view as the terminal host [RC], a separate terminal window glued
to Chrome [RC], stealth or anti-detection, cloud browsers, syncing Desk state between Macs, Macs shared with other user
accounts, scrollback or keystroke history on disk, Desk-managed tmux around panes, saving files dropped onto the
terminal, backups made by Desk itself (§6.4), builds for Intel Macs, and automatic updates (Desk changes version only
when you run `desk update`, `desk use`, `desk rollback`, or `npm run deploy`).

## 5. Behavior

### 5.1 Commands

| Command | Behavior |
|---|---|
| `desk` | Starts the Desk Chrome, or reuses the running one; loads the panel extension; shows and focuses the terminal in the last-focused Desk window, opening a window if none is open. The first run puts the panel on the left, turns off Chrome's background mode where this Chrome has it, and shows a welcome overlay in the panel. |
| `desk quit` | Closes the Desk Chrome through CDP. Pages are not asked about unsaved changes (Cmd+Q asks); the output says so. Shells keep running in the daemon; tmux keeps Claude. `--all` also stops the terminal daemon and `desk watch` after you confirm (tmux sessions survive). |
| `desk status` | Chrome (pid, ports, version), panel, daemon, watch, pane ids with alive or exited (never titles or directories), clients on the guarded endpoint, tabs any CDP client is attached to, and whether agents are paused. |
| `desk cdp` | Prints the guarded endpoint, `http://127.0.0.1:<gateway port>`. `--raw` prints the browser's own port; `--ws` prints the browser WebSocket URL of either. |
| `desk tab current` · `desk tab mine` | The target id of the tab you are looking at; the target id of this pane's agent tab, which Desk keeps in a tab group named after the pane and creates in the background when it is missing. |
| `desk agents` · `pause` · `resume` · `detach` | Lists agent-browser sessions started from Desk panes. `pause` refuses every agent-browser command from Desk shells until you `resume` (which asks you on a terminal). `detach` disconnects them. |
| `desk import cookies` · `desk import native-hosts --host <name>` | One-time imports from your main Chrome, each only on an interactive terminal after you confirm (§5.5). |
| `desk install` · `desk doctor` · `desk uninstall` | Setup, with consent for every step outside `~/.desk`; checks that each name their fix; removal of everything install recorded. |
| `desk --version` | The installed version, its channel (stable, edge, or dev), commit, branch, and build time, from the build's `version.json` (IMPLEMENTATION §23.4); `--json` prints the file. |
| `desk update` | After you confirm, installs the newest release (`--channel stable`, the default for a stable install), the newest build of `main` (`--channel edge`), or `--version X.Y.Z` next to the versions already installed, and makes it current. It accepts only what this repository's release or edge workflow built from `main`, checked against the release's `SHA256SUMS` and GitHub's build provenance, which needs `gh` 2.102.0 or later, signed in. It never moves to an older version unless you name one with `--version`, and then it says so. Shells and tmux sessions keep running; the next `desk` loads the new version and restarts `desk watch` with it. `--check` only reports. |
| `desk versions` · `desk use <version>` · `desk rollback` | Lists the installed versions (current, previous, and any the terminal daemon, `desk watch`, or a native host still run); switches to another installed version after you confirm; goes back to the previous one. They refuse a version that cannot read your current state files. |
| `npm run deploy` (in a checkout) | The developer path: builds the checkout as a dev version (`0.3.1-dev.<branch>+<commit>`), installs it after you confirm, and makes it current. Refuses uncommitted changes unless `--allow-dirty`. Never starts Chrome. |
| `desk daemon restart` | Restarts the terminal daemon after you confirm, without waiting for its own pane. Plain shells end; tmux sessions survive and re-attach. |
| `desk config toggle-key <key>` · `new-port` · `agent-policy strict\|open` | The panel shortcut (Chrome forgets changes made at chrome://extensions/shortcuts at its next start); a new guarded-endpoint port; whether agents may read cookies, storage, and saved state through agent-browser (`open` by default; going back to `open` after `strict` asks you first). |

One shortcut shows, focuses, and hides the panel (§5.3). Cmd+Q in the Desk Chrome asks before quitting: "Warn before
quitting" is on unless you turned it off [source], and `desk doctor` reports it.

### 5.2 What comes back

| Event | Logins, passwords | Tabs, with back history | Panel | Panes and screen | Shells | tmux and Claude |
|---|---|---|---|---|---|---|
| Cmd+Q or `desk quit`, then `desk` | yes | yes | yes | yes: the screen and the last 5,000 lines (tmux keeps its own history) | yes, never stopped | yes |
| Chrome update relaunch | yes | yes | yes, within 5 s (`desk watch`) | yes | yes | yes |
| Chrome crash or kill | yes, if older than about 40 s | yes, with no "Restore pages?" prompt | yes: `desk watch` relaunches Chrome (at most twice in 10 minutes), or run `desk` | yes | yes | yes |
| Panel hidden, or replaced by Reading list or another panel | — | — | back with the shortcut within 300 ms | yes | yes | yes |
| Last Desk window closed (for example Cmd+W on the last tab) | yes | Cmd+Shift+T reopens the window | `desk` opens a new window with the panel | yes | yes | yes |
| A second Desk window | — | — | each window can show the panel; a pane shows in one window at a time, with "bring it here" in the other | yes | yes | yes |
| Desk update (`desk update`, `desk use`, `desk rollback`, `npm run deploy`) | — | — | reloads at the next `desk` | yes | yes: the running daemon keeps its shells until you choose "Restart now" | yes |
| Terminal daemon crash or restart | — | — | — | layout and working directories; the screen only inside tmux | no (SIGHUP) | yes, re-attached |
| The stored debugging port is taken while Desk is down | — | — | — | — | — | Desk moves Chrome to a new port; the guarded URL agents use does not change |
| Mac restart or logout | yes | yes | yes | layout and working directories; panes re-attach to their tmux sessions as those come back | no | only with claude-rc supervision and its Desk change (IMPLEMENTATION §11); otherwise start again with `claude --resume` |

Chrome itself keeps logins, passwords, history, and tabs in the Desk profile. Desk's job is to make every exit
graceful (CDP, never a signal), to pass `--restore-last-session` on every launch so tabs and session cookies come back
without touching the syncable "Continue where you left off" setting [LAB, VMLAB, source], to recover tabs after a
crash, and to rebuild what Chrome never restores: the extension and the side panel [RC]. The labs ran with a mock
Keychain; the checklist settles the real one (MANUAL-CHECKS M5). Upgrading or removing your Node with nvm does not
affect Desk, which runs its own copy (§6.2).

### 5.3 Terminal

- Each pane is a real PTY running your login shell (`$SHELL -l`) with a clean environment, the same shape an SSH login
  gives Termius; your dotfiles build PATH, nvm, and `cc`. Desk never runs panes inside its own tmux, so `cc` sees
  `$TMUX` unset and starts claude in tmux with Remote Control exactly as in Termius [RF].
- Terminal tabs and horizontal and vertical splits; a pane can be zoomed. The layout, font size, and each pane's
  working directory persist (§5.2). New splits and tabs start in the focused pane's directory.
- Desk's shortcuts use keys Chrome lets the panel have: Cmd+D and Cmd+Shift+D split, Cmd+[ and Cmd+] move between
  panes, Cmd+1–9 pick a terminal tab, Cmd+F finds, Cmd+K clears, Cmd+= and Cmd+- change the font size. Text editing
  works as in Terminal.app: Option+Left/Right move by word, Option+Backspace deletes a word, Cmd+Left/Right go to the
  start or end of the line, Cmd+Backspace clears it, and Shift+Enter adds a newline in Claude's prompt. Chrome keeps
  Cmd+T, W, N, and Q (§5.6). Cmd+L leaves the terminal for the address bar.
- The panel shortcut (proposed default Cmd+Shift+Period; `desk config toggle-key`): hidden → shown and focused; shown
  but not focused → focused; focused → hidden.
- Paste: Desk removes escape and control characters from pasted or dropped text, so a page's "copy this command"
  cannot smuggle a second command into your shell; a multi-line paste into a program that has not asked for bracketed
  paste asks first. Dropped files are ignored.
- Links open as Desk tabs on Cmd+click, http and https only, and hovering shows the real URL. Programs can never read
  your clipboard through the terminal and can write it (OSC 52) only if you turn that on. tmux mouse mode works;
  Option-click forces a selection.
- A bell or a Claude notification marks the terminal tab, and the toolbar icon while the panel is hidden.
- The panel is 360 px wide at minimum and at most two thirds of the window; Chrome remembers your width [RC]. The
  terminal follows macOS light or dark mode.

### 5.4 Agents

- Inside a Desk pane, plain `agent-browser …` drives the Desk Chrome through the guarded endpoint. Each pane's agent
  has its own agent-browser session pinned to its own tab (`desk tab mine`); `agent-browser tab "$(desk tab current)"`
  moves it to the tab you are looking at. Agent tabs open in the background and must never change your active tab or
  move your keyboard focus (§8).
- The guarded endpoint passes every CDP domain through unchanged. It hides only Desk's own extension targets (the
  terminal) and refuses to close the browser, crash it, or install or remove extensions. `desk cdp --raw` prints the
  raw port, where every domain DevTools uses is available; only the PWA domain and `Page.addCompilationCache` need the
  pipe, which Desk never uses [RC]. Puppeteer and Playwright list only web pages on the guarded endpoint; on the raw
  port they list the terminal first, and the panel shows a red banner whenever anything is attached to the terminal.
- Desk's agent-browser config has no restore key, never saves state, wraps page text in content boundaries, and
  disconnects sessions idle for 15 minutes. Its policy is open by default (your choice on 2026-10-06): agents read and write
  cookies, storage, and saved state through agent-browser as DevTools can. `desk config agent-policy strict` refuses
  those commands, and `desk agents pause` refuses everything. Raw CDP is never filtered by this policy. Desk's defaults never read or write your
  `~/.agent-browser/config.json` or its `main` state [AB, RF]; a flag typed by hand can (§6.1), and `desk watch`
  warns when a Desk session writes agent-browser state.
- Claude Code: the desk skill pre-approves only reading and interacting with pages (snapshot, open, click, fill, type,
  press, scroll, get, wait, screenshot, tab, console, errors), `desk tab`, `desk cdp`, `desk status`, and
  `tyto open|brief|find`. Claude Code asks you for everything else: cookies, storage, state, eval, network, plugins,
  the dashboard, and any `desk` command that changes something.
- tmux: Desk shells carry the agent variables only when tmux will keep them out of other sessions, which one line in
  your tmux config ensures (`desk install` adds it with your consent and applies it to a running tmux server). Without
  it, the panel says agents cannot see the Desk. Sessions started from Termius never see Desk variables [RF].
- tyto: `tyto open`, `brief`, and `find` act on the Desk tabs (under the strict policy `brief` shows its cookie and
  storage sections as refused); `tyto run` replays keep running in Tyto's own sandboxed browser, because agent-browser
  refuses its domain allowlist with CDP [RF].
- When Desk is down, agents fail loudly ("Desk is not running") and never fall back to another browser.

### 5.5 Import

| What | How |
|---|---|
| Passwords, bookmarks, extensions, settings, payment methods, addresses; history and tabs with their toggle | Sign in to Chrome with Google in the Desk window [RC]. Passwords and payment methods then become fillable in a browser any local process can drive while it runs (§6.1). The welcome overlay suggests leaving password sync off, turning on Chrome's setting that asks for your screen lock before filling passwords, or keeping passwords in 1Password. |
| Site logins (cookies) | `desk import cookies`: you turn on remote debugging in your main Chrome, click Allow once, and pick the sites (none is preselected). Desk copies their cookies in memory, then waits until you turn remote debugging off again. Google account cookies are never copied, on any Google domain, on YouTube, or under their names on any site; sign in to Google directly [RC, OR]. |
| 1Password, Bitwarden, other password-manager apps | `desk import native-hosts --host <name>` copies one native-messaging manifest after showing its program, its code signer, and the extensions it serves; Apple Passwords already works [RC]. |
| Not imported | localStorage and open tabs of the main profile (Chrome has no Chrome-to-Chrome importer); Desk never copies profile folders [RC]. |

### 5.6 Chrome's limits Desk lives with

| Limit | Effect | Evidence |
|---|---|---|
| Reserved keys | Cmd+T, N, W, Q, Cmd+Shift+N, W, T, Ctrl+Tab, Ctrl+PgUp/PgDn, Cmd+Opt+Left/Right, and Cmd+Shift+[ and ] act on Chrome even while you type in the terminal: Cmd+W closes the current web tab, and on the last tab the window | RC (source; checklist M6) |
| One side panel per window | Reading list, Bookmarks, or Gemini replace the terminal until you toggle it back; the shells keep running | RC |
| A hidden panel is destroyed | Showing it reloads the terminal page; Desk re-attaches the panes within 300 ms | source |
| Shortcut changes in Chrome's UI | Chrome removes the CDP-loaded extension at every start, so set the shortcut with `desk config toggle-key` | RC |
| No windows, Chrome still running | Closing the last window leaves Chrome running with its port open, as any macOS app keeps running; `desk` opens a window, and `desk watch` quits Chrome after 10 minutes without a window | macOS behavior |
| Two Chromes | The Desk Chrome is a second, identical Chrome icon in the Dock; links from other apps probably open in your main Chrome (M13) | RC |
| First page | Puppeteer and Playwright on the raw port list the terminal panel as the first page | RC |
| Agent signals | agent-browser turns on Runtime and Network for tabs it tracks; sensitive sign-in pages can notice: pause agents first | RC, AB |
| Crash window | A login completed in the last seconds before a crash can be lost; state older than about 40 s survived every lab crash | LAB, VMLAB |

## 6. Security

### 6.1 Accepted risk (2026-10-06)

While the Desk Chrome runs, its debugging port `127.0.0.1:<port>` has no authentication. Any process that can open a
connection to 127.0.0.1 on this Mac — every program you run, any other macOS user account, and any sandboxed process
allowed to reach localhost — can read every cookie in the Desk profile including httpOnly ones; use your saved
passwords and payment autofill (open a login page, let Chrome fill it, read the field) unless Chrome first asks for
your screen lock; act on every signed-in site; read any page; install an unpacked extension; and type into the Desk
terminal, which runs a shell as you. Reading cookies and installing an extension over the port were both verified
[RC]. Chrome 136 stopped honoring this port on default profiles because infostealers abused it [ST]. You accepted this
exposure on 2026-10-06 in exchange for unrestricted agent access. Desk limits it to loopback, to the time the Desk
Chrome runs (with no window it quits after 10 minutes), and to a dedicated profile; keeps its shells and state off the
network; and gives Desk shells a guarded endpoint.

Also accepted, with these limits:

- Same-user processes can reach the terminal daemon's socket, as they can reach the port; the native host's origin
  check only keeps other extensions out.
- agent-browser's per-session stream server listens on loopback without a token and accepts any localhost page; a
  local dev page that learns its port can inject input into the agent's tab and read its broadcasts [AB]. Desk
  disconnects sessions idle for 15 minutes; under the default open policy a broadcast can carry cookie values an agent
  read (the strict policy keeps them out). A fix is requested upstream, and a live test tracks the gap.
- Agents can read every cookie and saved state of the Desk profile through agent-browser by default (your choice on
  2026-10-06, over the security review's recommendation). A page that prompt-injects an agent can make it read and leak
  session cookies. `desk config agent-policy strict` closes that path for agent-browser; the raw port stays open.
- agent-browser accepts global flags after the subcommand, so an injected agent can append `--cdp`, `--restore`, or
  `--action-policy` to a pre-approved command [source]. Desk warns when a Desk session writes agent-browser state and
  asks upstream for config keys that flags cannot override.
- Anyone who controls your Claude session through Remote Control with permissive settings can drive your signed-in
  sites through the agent [RF].
- Consent prompts need an interactive terminal; a process that types into your terminal (for example
  `tmux send-keys`) can answer them.
- Agents read signed-in pages; one can carry what it read off the machine in a URL it opens. Content boundaries and
  the skill's rules reduce this; nothing removes it.
- Sandboxed agents: a sandbox that allows 127.0.0.1 reaches both Desk ports. For agents that must stay sandboxed, deny
  127.0.0.1 on the raw and the guarded port in the sandbox's network settings.
- Agent pull requests merge themselves without a human review (your 2026-10-06 policy), so `main`, and every edge
  build made from it, holds code nobody read; its provenance proves where it was built, not that it was reviewed. A
  stable release is the version you chose to cut after reading what changed. Changes to the delivery pipeline and the
  agent rules wait for your merge by hand, but while agents use your own GitHub token that is a rule they follow, not
  a lock: the same token can merge them, or turn off a ruleset. A fine-grained token for agents narrows this
  (IMPLEMENTATION §22 D50, D51).

### 6.2 Controls

| Rule | Requirement |
|---|---|
| Port | Loopback only, fixed per install (9400–9899, never 9222 or 9229), open only while the Desk Chrome runs. Never `--remote-allow-origins`, never a non-loopback address. Chrome itself refuses WebSocket upgrades that carry an Origin header and requests whose Host is not an IP or localhost, which keeps web pages and DNS rebinding out [RC source, VMLAB] |
| Guarded endpoint | Served by `desk watch` on 127.0.0.1 only, with Chrome's Host and Origin rules and no CORS headers. Hides Desk's extension targets; refuses Browser.close and crash and extension installs; passes everything else. The raw port is never changed by it |
| No automation flags | Never the pipe, port 0, `--enable-automation`, `--headless`, or a Playwright/Puppeteer `launch()`: they set `navigator.webdriver`, add an infobar, or turn off password saving and filling [RC, LAB]. Desk also refuses the other switches that set `navigator.webdriver` or weaken the sandbox, site isolation, the keychain, or media permissions (IMPLEMENTATION §5) |
| Profile | A dedicated user-data-dir. Desk never writes your main Chrome profile. It reads it only for imports you confirm and for `desk doctor`'s read-only check that its remote debugging is off |
| Terminal daemon | No TCP port: a Unix socket in a 0700 directory you own, 1 MiB per message; the native host serves only the Desk extension's origin. Same-user processes can still reach the socket (§6.1) |
| Shell environment | Desk passes an allowlist and never `ANTHROPIC_API_KEY`, `TMUX`, `ELECTRON_*`, `NODE_OPTIONS`, `AGENT_BROWSER_CDP`, `AGENT_BROWSER_NAMESPACE`, or `AGENT_BROWSER_RESTORE*`. Your dotfiles still run and can export anything; `desk doctor` names (never shows the values of) what a login shell exports |
| Agents | Desk's agent-browser config and policy; `desk agents pause`; agent tabs in named groups; a red banner while anything is attached to the terminal |
| Terminal input and output | Pastes sanitized; OSC 52 reads never and writes only if enabled; no window reports; links only on Cmd+click; titles shown as plain text |
| Extension | A strict content security policy, no web-accessible resources, no connections from other extensions or pages; it uses Chrome's debugger API only to list targets |
| Files and logs | `~/.desk` is 0700 and owned by you; files are 0600 and written atomically. Titles, scrollback, keystrokes, cookie values, URLs, and CDP payloads never reach disk or logs; logs hold typed events only |
| Installed runtime | Desk runs from a versioned copy in `~/.desk/app` with its own copy of Node named Desk Terminal, never from the source tree, so macOS privacy prompts and grants name Desk Terminal rather than every `node`. Versions sit side by side; `current` switches atomically; `desk rollback` returns to the previous one |
| Updates | `desk update` and the fresh-Mac installer accept only what this repository's release workflow on that release's tag (or, for edge, its edge workflow on `main`) built from a commit on `main`, checked against `SHA256SUMS`, GitHub's release attestation, and build provenance with the exact workflow, ref, and commit (`gh attestation verify`, `gh` 2.102.0 or later); a published release is immutable and is published only after you approve it; nothing updates on its own, and nothing moves to an older version unless you name it |
| Imports | Opt-in per site; Google account cookies never move; both Chromes' listeners are verified before cookies move; values are never printed; the main Chrome's remote debugging is switched back off |
| Consent | §6.3 |
| Repo | Public repo: gitleaks `--redact` and a secret scan over code, docs, and tests; actions pinned by commit; no dependency install scripts; no profiles, state, traces, or keys committed. `main` takes changes only through pull requests whose required checks passed, and the checks that guard titles, workflows, and docs-only changes run from `main`'s own copy, so a pull request cannot weaken them. No ruleset has a bypass actor, so `--admin` merges fail for everyone; pipeline and agent-rule changes wait for your merge, or your agent session's once two independent security reviews approved the head commit, and the release PR for your merge by hand; only the release App creates tags. Agents holding your token can still merge, or turn off a ruleset, against the rules (§6.1; IMPLEMENTATION §23) |

### 6.3 Consent

These run only after you confirm on an interactive terminal, and refuse without one (there is no `--yes`): importing
cookies or native hosts; `desk install` and `desk uninstall` steps outside `~/.desk` (tmux config, `~/.claude` and
`~/.cursor` rules and skills, Desk.app, the login item); `desk quit --all`; `desk daemon restart`;
`desk agents resume`; `desk config agent-policy open`; and changing the installed version: `desk update`, `desk use`,
`desk rollback`, and `npm run deploy`. Each writes one audit line to `desk.log` with the operation, counts, and exit
code, never names or values.

### 6.4 Backups

The Desk profile and `~/.desk` are ordinary files. Back them up with encrypted Time Machine: localStorage and
IndexedDB are plaintext on disk, and only cookies and passwords use the "Chrome Safe Storage" key. Never place them in
iCloud Drive, Dropbox, or Google Drive folders (`desk doctor` warns). A restore on another Mac cannot decrypt cookies
or passwords, because that key lives in this Mac's Keychain, so expect to sign in again there.

### 6.5 If the Desk profile may be compromised

Run `desk quit --all` (the port closes), sign out of other sessions in your Google account, sign out of the sites you
imported, change the passwords that synced into Desk, then delete and recreate the profile
(`desk uninstall --profile`, then `desk install`).

## 7. Platforms

macOS on Apple silicon (developed on macOS 26, Darwin 25.6). Google Chrome stable ≥ 155; the behavior Desk relies on
was verified on 155.0.8059.26 and 155.0.8059.40 on macOS [RC, LAB] and on 155.0.8059.39 for Linux arm64 in the test VM
[VMLAB]. Desk brings its own copy of Node, Desk Terminal: Node 26.10.0 for darwin-arm64, pinned by sha256 (a
developer build copies your Node only when it matches that pin); development uses Node 26, and the packages declare
engines `^22.22.2 || ^24.15.0 || >=26`. Releases are built for macOS on Apple silicon only. tmux (the environment
behavior Desk relies on was verified on 3.7c [RF]). agent-browser ≥ 0.38.1. Linux runs Desk only inside its test
container. Windows: not supported.

## 8. Quality bars

| Bar | Target | Measured |
|---|---|---|
| Nothing on your screen during development or tests | 0 windows: unit tests start no browser and no PTY; live tests run only in the Desk test container (the Colima VM, or GitHub's arm64 runner in CI); no test touches your `~/.desk` | GUI-guard and isolation tests (IMPLEMENTATION §0, §17) |
| Cold `desk` until the panel shows a live shell | ≤ 2.5 s p50, ≤ 4 s p95 (confirmed or revised by the slice 1c baseline) | live VM; checklist |
| `desk` with Chrome already running, until the panel is focused | ≤ 0.5 s | live VM |
| Showing the hidden terminal until it takes input | ≤ 300 ms p95 with 4 visible panes | live VM; checklist |
| Keystroke to echo (panel input to the echoed byte's write callback) | p50 ≤ 5 ms, p95 ≤ 15 ms | live VM recorded; a macOS spot check decides |
| Heavy output | 50 MB finishes without freezing the panel; Ctrl+C stops it within 0.5 s; a minimized window never pauses a shell for more than 1 s | live VM |
| Re-logins | 0 across 10 quit-and-relaunch cycles and an update relaunch: persistent and session cookies, localStorage, IndexedDB, saved passwords | live VM; checklist for the real Keychain and Google |
| Crash | Tabs restore automatically; state older than 40 s survives | live VM; [LAB, VMLAB] |
| Panes | 100% re-attach after a Chrome restart with the screen intact; 100% return in their working directory after a daemon restart, including a `cd` made 2 s before | live VM |
| tmux sessions | 100% survive Chrome quit, crash, update, a Desk update, and a daemon restart, and their panes re-attach | live VM |
| Desk update | 0 shells lost when a version is installed, updated to, or rolled back to while panes run | live VM |
| Release integrity | Every published asset carries build provenance from the release workflow on its tag; `desk update` installs nothing that fails its sha256 or provenance check | release workflow; slice D2 tests |
| Agents and your view | An agent opening or using its tab never changes your active tab or keyboard focus | live VM (slice 4b) |
| Automation fingerprint | `navigator.webdriver` is false on every tab; no infobar (window chrome as tall as a launch without Desk's flags) | live VM; checklist; `desk doctor --security` |
| Your agent state | `~/.agent-browser/config.json` and `sessions/` byte-identical after any Desk run, including `desk agents detach` run from another terminal | live VM |
| Secrets on disk | No canary typed, pasted, printed, set as a title, or set as a cookie appears in any file Desk writes | live VM canary test |
| `npm test` | Offline, under 30 s | CI |

## 9. One-line tests

- If you have to sign in again after quitting, an update, or a crash more than a minute after you signed in, Desk is
  not done.
- If quitting or updating Chrome or Desk stops a Claude session, Desk is not done.
- If `cc` behaves differently in Desk than in Termius, Desk is not done.
- If an agent cannot reach something DevTools can (on the raw port), Desk is not done.
- If an agent's tab takes your keyboard or your view, Desk is not done.
- If text you paste runs something you did not see, Desk is not done.
- If a test or a development step opens a window on your Mac or changes your `~/.desk`, Desk is not done.
- If a cookie value, a keystroke, terminal output, or a window title reaches a file or log Desk writes, Desk is not
  done.
- If Desk changes your main Chrome profile or your agent-browser `main` state, Desk is not done.
- If `desk --version` cannot name the commit your Desk was built from, or Desk installs a build that this
  repository's release or edge workflow did not build, Desk is not done.

## 10. Evidence

All sources are in the research archive of 2026-10-06, which stays outside the public repo.

| Key | Source | What it settles |
|---|---|---|
| RC | `reports/real-chrome.md` | Real Chrome 155 with a fixed port: no prompt, no infobar, webdriver false; side-panel terminal prototype; `Extensions.loadUnpacked` and `triggerAction` over the port; left placement; reserved keys; native messaging; settingsPrivate; import facts |
| AB | `reports/agent-browser-source.md` | How agent-browser 0.38.1 connects, picks and pins tabs, its stream server, and the restore load/autosave hazard |
| RF | `reports/repo-fit.md` | Tyto conventions to copy, PTY environment lessons, tmux update-environment (verified on 3.7c), why `AGENT_BROWSER_CDP` and `NAMESPACE` must never be exported, Tyto limits |
| PA | `reports/prior-art.md` | Orca, Superset, VS Code, cmux, Claude Desktop: nobody ships this exact product |
| ST | `reports/stack.md` | xterm 6 and addon versions, node-pty status, VS Code flow control, Chromium's port protections |
| CR | `reports/critic.md` | Contradictions resolved: environment variables, node-pty version, npm install-script policy |
| OR | `reports/orca.md` | Daemon-owned PTYs with warm reattach and snapshot replay as prior art; Orca's cookie import rules |
| SP | `reports/spike.md` | Electron spike (background only); the gateway prototype |
| LAB | `chrome-persist/results/*.json` | macOS raw lab on Chrome 155.0.8059.26 and .40 with a mock Keychain: exit modes against what survives, crash flags, `--restore-last-session`, singleton reuse, a Chrome update |
| VMLAB | `lab/` (Dockerfile, run.sh, results, out) | Colima VM lab: branded Chrome 155.0.8059.39 for linux-arm64 with its sandbox on; extension, left panel, native messaging, agent-browser; persistence matrix and timing sweep; node-pty PTY and tmux checks |
| PROTO | `real-chrome/ext/desk-panel`, `nmhost/host.mjs`, `launch.sh`, `exp2.mjs`, `exp3.mjs`, `openpanel.mjs`, `cdp.mjs` | Working prototype to reuse |
| source | Chromium 155, xterm.js 6.0.0, and agent-browser 0.38.1 source, cited by file and line in the reports and the 2026-10-06 review | Behavior read in code |
