import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESK_EXTENSION_ID, type Panes } from "../../packages/core/src/index.ts";
import { UnixDaemonClient } from "../../packages/cli/src/index.ts";
import { Cdp, attach, evaluate, targets, waitFor } from "./lib/cdp.ts";
import { browserVersion } from "./lib/chrome.ts";
import { installDesk, runAnswering, userEnv, type InstalledDesk } from "./lib/desk-run.ts";
import { LIVE_PORTS } from "./lib/ports.ts";
import { saveResult } from "./lib/results.ts";

const run = promisify(execFile);
const PORT = LIVE_PORTS.survive;
const PANEL_URL = `chrome-extension://${DESK_EXTENSION_ID}/panel.html`;

let installed: InstalledDesk | undefined;

async function panes(daemon: UnixDaemonClient): Promise<Panes | null> {
  const opened = await daemon.open("cli");
  if (!opened.ok) return null;
  try {
    const reply = await opened.session.request({ type: "list" });
    return reply?.type === "panes" ? reply : null;
  } finally {
    opened.session.close();
  }
}

/** Whether a process with this pid runs. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("the terminal daemon outlives Chrome (slice 2a) in the live container", () => {
  beforeAll(async () => {
    installed = await installDesk({ port: PORT, resultTag: "survive" });
    const launch = await installed.desk();
    if (launch.code !== 0) throw new Error(`desk exited ${launch.code}: ${launch.stderr.trim()}`);
  }, 240_000);

  afterAll(async () => {
    if (installed === undefined) return;
    await runAnswering(join(installed.home, ".local", "bin", "desk"), ["quit", "--all"], userEnv(installed.home), "y").catch(() => undefined);
  }, 60_000);

  it(
    "the daemon and its shells survive SIGKILL of every Chrome process",
    async () => {
      if (installed === undefined) throw new Error("Desk did not start");
      const { home, deskHome } = installed;
      const cdp = await Cdp.connect((await browserVersion(PORT)).webSocketDebuggerUrl);
      const panel = await waitFor(async () => (await targets(cdp)).find((t) => t.url === PANEL_URL), { label: "the Desk panel" });
      const session = await attach(cdp, panel.targetId);
      const pane = await waitFor(() => evaluate<string | null>(cdp, session, "typeof deskTest === 'object' && deskTest.panes().length > 0 ? deskTest.panes()[0] : null"), {
        label: "the panel's pane",
      });
      await waitFor(async () => (await evaluate<string>(cdp, session, `deskTest.screen(${JSON.stringify(pane)})`)).includes("desk-live %"), {
        label: "the shell's prompt",
        timeoutMs: 30_000,
      });
      // The shell writes its own pid where the test can read it.
      await evaluate(cdp, session, "document.querySelector('textarea.xterm-helper-textarea')?.focus(), true");
      await cdp.send("Input.insertText", { text: "echo $$ > ~/shell.pid" }, { sessionId: session });
      for (const type of ["keyDown", "keyUp"]) {
        await cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) }, { sessionId: session });
      }
      const shellPid = await waitFor(async () => Number((await readFile(join(home, "shell.pid"), "utf8").catch(() => "")).trim()) || null, { label: "the shell's pid" });
      const daemonPid = (JSON.parse(await readFile(join(deskHome, "run", "ptyd.lock"), "utf8")) as { pid: number }).pid;
      cdp.close();
      const daemon = new UnixDaemonClient(join(deskHome, "run", "ptyd.sock"), "live");
      const before = await panes(daemon);

      const chromes = (await run("pgrep", ["-x", "chrome"]).catch(() => ({ stdout: "" }))).stdout.trim().split("\n").filter(Boolean).map(Number);
      for (const pid of chromes) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone with its browser process.
        }
      }
      await waitFor(async () => !(await browserVersion(PORT).then(() => true, () => false)), { label: "Chrome gone", timeoutMs: 15_000 });
      await waitFor(async () => (await run("pgrep", ["-x", "chrome"]).then(() => false, () => true)), { label: "every Chrome process gone", timeoutMs: 15_000 });
      const after = await panes(daemon);
      await saveResult("survive-chrome-kill", { killed: chromes.length, daemonPid, shellPid, before, after, daemonAlive: alive(daemonPid), shellAlive: alive(shellPid) });

      expect(chromes.length).toBeGreaterThan(0);
      expect(alive(daemonPid)).toBe(true);
      expect(alive(shellPid)).toBe(true);
      expect(after?.panes).toEqual([{ id: pane, alive: true, owned: false }]);
    },
    180_000,
  );
});
