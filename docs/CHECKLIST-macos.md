# Tyto Desk — Manual checks on your Mac

Status: draft 2 (2026-10-06). Becomes `docs/CHECKLIST-macos.md` in the repo. These are the checks the Colima VM cannot
make (IMPLEMENTATION §17.5): your real account, the Keychain, LaunchServices, hardware keys, macOS privacy prompts,
logout. Each item names the slice that makes it runnable.

**When.** Run B, the full run, once after slice 8 (about 35 minutes). Run A is optional, after slice 4a (about
10 minutes), to catch macOS-only surprises early. Run U after Chrome's major version changes (about 5 minutes;
`desk doctor` reminds you).

**Before you start**
- `desk install` is done, and (from slice 5 on) `desk doctor` reports no problems.
- Termius is open, your phone has the Claude app, and 1Password is installed if you use it.
- For M5, M15, and M17 use a throwaway login (a test account or `desk doctor --autofill-probe`'s local page), never a
  real password. Never paste a password into the terminal.
- Your Desk ports: `desk cdp --raw` and `desk cdp`.

**Recording.** Write results only to `docs/checklist-results/<date>.json`, with no notes, because free text could
hold secrets:

```json
{ "date": "2026-11-02", "run": "B", "chrome": "155.0.8059.40", "desk": "<build id from desk status>",
  "results": { "M1": "pass", "M4a": "fail", "M10": "skip" } }
```

A failure does not block you: record it, keep using Desk, and tell the development session which id failed.

## Run A (optional, after slice 4a)

M1, M2, M5, M7, M8, M9 below.

## Run B (after slice 8)

Every item, including Run A's.

**M1 — Desk starts (1c).** In Termius run `desk`. Pass: a Chrome window opens with the terminal on the left, no
"Chrome is being controlled by automated test software" bar, a second Chrome icon in the Dock, and `desk` prints
"Desk ready".

**M2 — Chrome keeps its own identity (1c).** In a Desk tab open https://permission.site and click Camera. Pass: the
macOS prompt names Google Chrome, not Termius. Click Don't Allow.

**M3 — `desk` brings Desk forward (3b).** Click another app, then run `desk` again in Termius. Pass: the Desk window
comes to the front with the terminal focused.

**M4 — Google sign-in with an agent attached, then paused (4b).**
- M4a: open https://accounts.google.com in a Desk tab. In a pane run `agent-browser tab "$(desk tab current)"` and
  `agent-browser get title`, then sign in on that tab. Pass: Google lets you in. A fail ("this browser may not be
  secure") only confirms the advice to pause agents for sign-ins.
- M4b: run `desk agents detach` and `desk agents pause`. Use Chrome's profile button (top right) to sign in to Chrome
  and turn on sync; on the sync screen choose what to sync, and leave Passwords off unless you accept SPEC §6.1. Pass:
  you are signed in, sync is on, your bookmarks arrive. Then run `desk agents resume` and confirm.

**M5 — Quit and come back (3a).** Sign in to a throwaway test login and let Chrome save the password. Open three tabs
and click a link in one. Wait one minute. Press Cmd+Q and hold it (Chrome's warning appears). Run `desk`. Pass: still
signed in, the password still saved, the three tabs back with Back working, and the terminal panes back.

**M6 — Real keys in the terminal (6).** In a pane, check each:
- Cmd+D and Cmd+Shift+D split; Cmd+[ and Cmd+] move between panes; Cmd+1…9 pick a terminal tab; Cmd+Opt+T opens a
  terminal tab and Cmd+Opt+W closes a pane; Cmd+F finds; Cmd+K clears; Cmd+= and Cmd+- change the font size, and the
  size is still there after `desk quit` and `desk`.
- At a zsh prompt: Option+Left and Option+Right jump a word; Option+Backspace deletes a word; Cmd+Left and Cmd+Right
  go to the line's start and end; Cmd+Backspace clears the line. In Claude's prompt, Shift+Enter adds a new line.
- The panel shortcut (Cmd+Shift+Period): hidden → shown and focused. Click a web page, then press it: the terminal
  takes focus without reloading. Press it again: hidden. Cmd+L moves you to the address bar.
- Expected, because Chrome owns them: Cmd+W closes the current web tab and Cmd+T opens one. (You can remap Chrome's
  Close Tab in System Settings > Keyboard > Keyboard Shortcuts > App Shortcuts; that also changes your main Chrome.)
- Ctrl+Tab from the terminal switches web tabs; note whether the terminal keeps the keyboard afterwards.
- If you use an input method, compose one character into the shell.

Pass: everything behaves as described.

**M7 — `cc` and Remote Control (1c).** In a pane run `cd ~/Dev/<a project>` and `cc`. Pass: Claude starts inside tmux;
`tmux ls` in Termius shows a session named after the folder; the Claude app on your phone lists it under the same
name. Then compare variable names only: in the Desk pane (outside tmux) run `env | cut -d= -f1 | sort >
/tmp/desk-names`; in Termius run `env | cut -d= -f1 | sort > /tmp/termius-names`; run
`diff /tmp/termius-names /tmp/desk-names`, then delete both files. Pass: no name your dotfiles set (PATH helpers,
`NVM_*`, your own exports) is missing in Desk. Expected differences are only names Desk sets (`TERM_PROGRAM`,
`TERM_PROGRAM_VERSION`, `COLORTERM`, `CLICOLOR`, `DESK_PANE`, `AGENT_BROWSER_CONFIG`, `AGENT_BROWSER_SESSION`,
`DESK_CDP_URL`) and names only an SSH login or only a desktop session has (`SSH_*`, `TMPDIR`,
`__CF_USER_TEXT_ENCODING`, locale names). Never compare values.

**M8 — Claude outlives Chrome (2b).** With Claude running in a pane, quit the Desk Chrome (hold Cmd+Q). In Termius,
`tmux ls` still lists the session. Run `desk`. Pass: the pane re-attaches with the same conversation running.

**M9 — Privacy prompts name Desk (1c).** In a pane run `ls ~/Documents`. Pass: if macOS asks, the dialog names "Desk
Terminal", not "node" and not "Google Chrome". Answer as you like; the grant applies to Desk Terminal only (System
Settings > Privacy & Security > Files and Folders lists it).

**M10 — 1Password, if you use it (8).** Run `desk import native-hosts --host com.1password.1password`. Check that the
program shown is in `/Applications/1Password.app` and that the signer is 1Password's, then confirm. Add the 1Password
extension in the Desk Chrome if sync did not. Pass: Touch ID unlocks it, and it fills a login.

**M11 — Cookie import (8).** Run `desk import cookies` and follow it: turn on remote debugging in your main Chrome,
click Allow once, pick one site you are signed in to. Pass: that site is signed in inside Desk, and `desk` then waits
until you have turned remote debugging off in the main Chrome and confirms it.

**M12 — Chrome update relaunch (3b; whenever Chrome offers one).** In the Desk Chrome click "Relaunch to update" (or
chrome://settings/help). Pass: within 5 s the terminal is back with its panes, you are still signed in, and
`desk cdp --raw` prints the same port as before.

**M13 — Links from other apps (1c).** Click a link in Mail, Slack, or Notes. Pass: your main Chrome opens it, so Desk
has not become your default browser.

**M14 — Logout or restart (3a, 7).** With Claude running in a pane and a few tabs open, log out and back in (or
restart). Pass: no Desk Chrome or Desk port appears by itself (`lsof -nP -iTCP:<raw port> -sTCP:LISTEN` prints
nothing until you run `desk`). After `desk`: still signed in, tabs back, panes back in their folders. tmux sessions
re-attach if they came back, which after a restart needs claude-rc supervision.

**M15 — Crash (3b).** One minute after signing in to a throwaway test login, force-quit the Desk Chrome in Activity
Monitor. Pass: Desk relaunches it within a few seconds (or run `desk`), the tabs are back with no "Restore pages?"
prompt, and you are still signed in.

**M16 — The port closes (3a, 3b).** (a) Quit the Desk Chrome with Cmd+Q: `lsof -nP -iTCP:<raw port> -sTCP:LISTEN`
prints nothing. (b) Run `desk`, close every Desk window with its red button, and wait 10 minutes: the same command
prints nothing.

**M17 — Password fill needs you (8).** In the Desk Chrome's Password Manager settings, turn on the option that asks for
your screen lock before filling passwords. Run `desk doctor --autofill-probe` and save the throwaway password it shows
when Chrome offers. Pass: when the probe asks Chrome to fill over CDP, macOS asks for Touch ID or your password first;
when you cancel, the field stays empty. Delete the throwaway password afterwards.

**M18 — Agents pause (4b).** Run `desk agents pause`, then in a pane `agent-browser get title`. Pass: it is refused by
policy and the terminal shows "agents paused". `desk agents resume` asks you to confirm.

## Run U (after Chrome's major version changes)

1. `desk doctor --security` passes (the port refuses web pages, no automation flag, no infobar).
2. M1 and M5.
3. From M6: Cmd+W and Cmd+T still belong to Chrome, and the panel shortcut still shows, focuses, and hides the
   terminal.
4. M12, if Chrome relaunched itself for the update.

If any of these fails, pause agents (`desk agents pause`) until a Desk fix ships, and sign in to sites in your main
Chrome meanwhile.
