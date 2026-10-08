import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESK_EXTENSION_ID, type LayoutShown } from "../../packages/core/src/index.ts";
import { Cdp, attach, evaluate, targets, waitFor } from "./lib/cdp.ts";
import { browserVersion } from "./lib/chrome.ts";
import { installDesk, runAnswering, userEnv, type InstalledDesk } from "./lib/desk-run.ts";
import { startFixtureServer, type FixtureServer } from "./lib/fixture-server.ts";
import { LIVE_PORTS } from "./lib/ports.ts";
import { saveFile, saveResult } from "./lib/results.ts";

const PORT = LIVE_PORTS.restore;
const PANEL_URL = `chrome-extension://${DESK_EXTENSION_ID}/panel.html`;
const run = promisify(execFile);

let installed: InstalledDesk | undefined;
let fixture: FixtureServer | undefined;
let cdp: Cdp | undefined;
let session = "";

function desk(): InstalledDesk {
  if (installed === undefined) throw new Error("Desk did not start (see the beforeAll failure)");
  return installed;
}

function browser(): Cdp {
  if (cdp === undefined) throw new Error("no browser connection");
  return cdp;
}

/** Connects to the Desk panel once its layout is up. */
async function connectPanel(): Promise<void> {
  cdp?.close();
  cdp = await Cdp.connect((await browserVersion(PORT)).webSocketDebuggerUrl);
  const target = await waitFor(async () => (await targets(browser())).find((t) => t.url.startsWith(PANEL_URL)), { label: "the Desk panel", timeoutMs: 30_000 });
  session = await attach(browser(), target.targetId);
  await browser().send("Emulation.setFocusEmulationEnabled", { enabled: true }, { sessionId: session });
  await waitFor(() => evaluate<boolean>(browser(), session, "typeof deskTest === 'object' && deskTest.layout() !== null"), { label: "the layout" });
}

const shown = () => evaluate<LayoutShown | null>(browser(), session, "deskTest.layout()");
const screen = (pane: string) => evaluate<string>(browser(), session, `deskTest.screen(${JSON.stringify(pane)})`);
const act = (name: string) => evaluate(browser(), session, `deskTest.action(${JSON.stringify(name)}), true`);

/** The active tab's panes, in reading order. */
async function panes(): Promise<string[]> {
  return JSON.stringify((await shown())?.root ?? null).match(/p_\w{10}/g) ?? [];
}

/** Types a line into a pane, as its user would, whichever pane has the keyboard. */
async function typeLine(pane: string, text: string): Promise<void> {
  const typed = await evaluate<boolean>(browser(), session, `deskTest.input(${JSON.stringify(pane)}, ${JSON.stringify(`${text}\r`)})`);
  if (!typed) throw new Error(`the panel has no terminal for ${pane}`);
}

/** A line the pane printed after the command was entered; on a timeout, the screen, the layout and panes.json are saved. */
async function output(pane: string, pattern: RegExp, label: string, timeoutMs = 30_000): Promise<string> {
  try {
    return await waitFor(async () => pattern.exec(await screen(pane))?.[0] ?? null, { label, timeoutMs });
  } catch (err) {
    const state = {
      label,
      pane,
      screen: await screen(pane).catch((e: unknown) => `unreadable: ${String(e)}`),
      layout: await shown().catch(() => null),
      panes: await evaluate<string[]>(browser(), session, "deskTest.panes()").catch(() => null),
      banner: await evaluate<string>(browser(), session, "deskTest.banner()").catch(() => null),
      panesJson: await readFile(join(desk().deskHome, "panes.json"), "utf8").catch(() => null),
    };
    await saveResult(`restore-timeout-${label.replace(/\W+/g, "-")}`, state);
    throw err;
  }
}

/** The daemon, killed: no flush, no goodbye (§7.4's "after the daemon is killed"). The panel reconnects and the host starts a new one. */
async function killDaemon(): Promise<void> {
  const lock = JSON.parse(await readFile(join(desk().deskHome, "run", "ptyd.lock"), "utf8")) as { pid: number };
  process.kill(lock.pid, "SIGKILL");
  await waitFor(async () => {
    try {
      process.kill(lock.pid, 0);
      return false;
    } catch {
      return true;
    }
  }, { label: "the daemon gone" });
  await waitFor(async () => {
    const now = JSON.parse(await readFile(join(desk().deskHome, "run", "ptyd.lock"), "utf8").catch(() => "{}")) as { pid?: number };
    return now.pid !== undefined && now.pid !== lock.pid;
  }, { label: "a new daemon", timeoutMs: 30_000 });
}

async function tmux(...args: string[]): Promise<string> {
  return (await run("tmux", args, { env: userEnv(desk().home) })).stdout;
}

/** Every regular file under a directory, sockets and other specials left out. */
async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

describe("cold restore (slice 7) in the live container", () => {
  beforeAll(async () => {
    installed = await installDesk({ port: PORT, resultTag: "restore" });
    fixture = await startFixtureServer();
    const launch = await installed.desk();
    if (launch.code !== 0) throw new Error(`desk exited ${launch.code}: ${launch.stderr.trim()}`);
    await connectPanel();
    const [first] = await panes();
    if (first === undefined) throw new Error("no pane");
    await output(first, /desk-live %/, "a prompt");
  }, 240_000);

  afterAll(async () => {
    cdp?.close();
    await fixture?.close();
    if (installed === undefined) return;
    await tmux("kill-server").catch(() => undefined);
    const logs = join(installed.deskHome, "logs");
    for (const name of await readdir(logs).catch(() => [])) await saveFile(`restore-log-${name}`, await readFile(join(logs, name)));
    await runAnswering(join(installed.home, ".local", "bin", "desk"), ["quit", "--all"], userEnv(installed.home), "y").catch(() => undefined);
  }, 60_000);

  it(
    "cd, then killing the daemon 2 s later, brings the pane back in the new directory",
    async () => {
      const [pane] = await panes();
      if (pane === undefined) throw new Error("no pane");
      await typeLine(pane, "mkdir -p /tmp/desk-cd-a && cd /tmp/desk-cd-a && echo cd-done");
      await output(pane, /^cd-done$/m, "the cd");
      await new Promise((resolve) => setTimeout(resolve, 2_000));

      await killDaemon();
      await connectPanel();
      // The restored pane's dim line, then its new shell's prompt: the new snapshot is in, so typing reaches the shell.
      await output(pane, /daemon stopped[\s\S]*desk-live %/, "a prompt again");
      await typeLine(pane, "echo here-$(pwd)");
      const line = await output(pane, /^here-\S+$/m, "the directory");
      await saveResult("restore-cd", { line, panesJson: await readFile(join(desk().deskHome, "panes.json"), "utf8").catch(() => null) });

      expect(line).toBe("here-/tmp/desk-cd-a");
    },
    120_000,
  );

  it(
    "after the daemon is killed, every pane returns in its cwd and the tmux pane re-attaches with its process still running",
    async () => {
      const [first] = await panes();
      if (first === undefined) throw new Error("no pane");
      await typeLine(first, "mkdir -p /tmp/desk-r1 && cd /tmp/desk-r1 && echo r1-done");
      await output(first, /^r1-done$/m, "the cd");
      await act("split-down");
      const second = await waitFor(async () => (await panes()).find((p) => p !== first) ?? null, { label: "the second pane" });
      await output(second, /desk-live %/, "a prompt in the second pane");
      await typeLine(second, "tmux new -s deskr2");
      await output(second, /\[deskr2\]/, "tmux in the second pane");
      await typeLine(second, "sleep 3600");
      // The tmux session is read about 1 s after a command is entered.
      await new Promise((resolve) => setTimeout(resolve, 2_000));

      await killDaemon();
      await connectPanel();
      await output(second, /\[deskr2\]/, "tmux attached again");
      await output(first, /daemon stopped[\s\S]*desk-live %/, "the first pane's new prompt");
      const running = await tmux("list-panes", "-t", "=deskr2", "-F", "#{pane_current_command}");
      await typeLine(first, "echo here-$(pwd)");
      const line = await output(first, /^here-\S+$/m, "the first pane's directory");
      await saveResult("restore-tmux", { running, line });

      expect(line).toBe("here-/tmp/desk-r1");
      expect(running.trim()).toBe("sleep");
      await tmux("kill-session", "-t", "=deskr2").catch(() => undefined);
    },
    180_000,
  );

  it(
    "a pane restored before its tmux session exists re-attaches when the session is created",
    async () => {
      const [pane] = await panes();
      if (pane === undefined) throw new Error("no pane");
      await typeLine(pane, "tmux new -s deskl3");
      await output(pane, /\[deskl3\]/, "tmux in the pane");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      // The session goes: the pane's client exits, and lastTmux keeps its name.
      await tmux("kill-session", "-t", "=deskl3");
      await output(pane, /desk-live %\s*$/, "the shell back");

      await killDaemon();
      await connectPanel();
      await output(pane, /comes back/, "the waiting line");
      await tmux("new-session", "-d", "-s", "deskl3");
      await output(pane, /\[deskl3\]/, "the pane attached to the new session");
      // The session ends: its client exits, and the pane goes on as a login shell (§7.4) before the next test types.
      await tmux("kill-session", "-t", "=deskl3").catch(() => undefined);
      await output(pane, /\[exited\][\s\S]*desk-live %\s*$/, "the login shell after the session");
    },
    180_000,
  );

  it(
    "no canary typed, pasted, printed, set as a title or set as a cookie appears in any file Desk writes",
    async () => {
      const canary = `desk-canary-${randomBytes(6).toString("hex")}`;
      const [pane] = await panes();
      if (pane === undefined) throw new Error("no pane");
      await output(pane, /desk-live %/, "a prompt");
      // Typed (the shell's input), then printed and set as a title by a program.
      await typeLine(pane, `: ${canary}-typed; printf '%s\\n' ${canary.slice(0, 6)}"${canary.slice(6)}-printed"; printf '\\033]0;%s\\007' ${canary.slice(0, 6)}"${canary.slice(6)}-title"`);
      await output(pane, new RegExp(`^${canary}-printed$`, "m"), "the printed canary");
      // Pasted, through the panel's paste path.
      await evaluate(
        browser(),
        session,
        `(() => { const data = new DataTransfer(); data.setData('text/plain', ${JSON.stringify(`: ${canary}-pasted`)}); document.querySelectorAll('.pane')[0].dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); return true; })()`,
      );
      // A cookie, set in the Desk browser (through CDP's fields, so no cookie header is spelled out here).
      await browser().send("Storage.setCookies", { cookies: [{ url: `${fixture?.origin ?? ""}/`, name: "desk", value: `${canary}-cookie` }] });
      // Every save Desk makes is due well within this; then a quit flushes the rest.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      cdp?.close();
      cdp = undefined;
      await desk().desk(["quit"]);

      const hits: string[] = [];
      for (const file of await filesUnder(desk().deskHome)) {
        if ((await stat(file)).size > 64 * 1024 * 1024) continue;
        if ((await readFile(file)).includes(canary)) hits.push(file.slice(desk().deskHome.length));
      }
      await saveResult("restore-canary", { hits });

      expect(hits).toEqual([]);
      const relaunch = await desk().desk();
      expect(relaunch.code).toBe(0);
    },
    180_000,
  );
});
