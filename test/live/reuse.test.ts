import { readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESK_EXTENSION_ID, parseDeskConfig, type Panes } from "../../packages/core/src/index.ts";
import { UnixDaemonClient } from "../../packages/cli/src/index.ts";
import { Cdp, attach, evaluate, targets, waitFor } from "./lib/cdp.ts";
import { browserVersion } from "./lib/chrome.ts";
import { installDesk, runAnswering, userEnv, type InstalledDesk, type Run } from "./lib/desk-run.ts";
import { LIVE_PORTS } from "./lib/ports.ts";
import { saveResult } from "./lib/results.ts";

const PORT = LIVE_PORTS.reuse;
const PANEL_URL = `chrome-extension://${DESK_EXTENSION_ID}/panel.html`;
const WORKER_URL = `chrome-extension://${DESK_EXTENSION_ID}/sw.js`;

let installed: InstalledDesk | undefined;
let daemon: UnixDaemonClient | undefined;

function desk(): InstalledDesk {
  if (installed === undefined) throw new Error("Desk did not start (see the beforeAll failure)");
  return installed;
}

async function launchDesk(): Promise<Run> {
  const run = await desk().desk();
  if (run.code !== 0) throw new Error(`desk exited ${run.code}: ${run.stderr.trim()}`);
  return run;
}

/** The daemon's pane list, through a client of kind cli. */
async function panes(): Promise<Panes | null> {
  if (daemon === undefined) return null;
  const opened = await daemon.open("cli");
  if (!opened.ok) return null;
  try {
    const reply = await opened.session.request({ type: "list" });
    return reply?.type === "panes" ? reply : null;
  } finally {
    opened.session.close();
  }
}

/** The Desk Chrome's main pid, from its profile's SingletonLock. */
async function chromePid(): Promise<number> {
  const parsed = parseDeskConfig(await readFile(join(desk().deskHome, "config.json"), "utf8"));
  if (!parsed.ok) throw new Error("config.json did not parse");
  return Number(/-(\d+)$/.exec(await readlink(join(parsed.config.chrome.userDataDir, "SingletonLock")))?.[1]);
}

/** The panel's pane, and a session on the panel to read and type into its terminal. */
async function panel(cdp: Cdp): Promise<{ session: string; pane: string }> {
  const target = await waitFor(async () => (await targets(cdp)).find((t) => t.url.startsWith(PANEL_URL)), { label: "the Desk panel" });
  const session = await attach(cdp, target.targetId);
  const pane = await waitFor(() => evaluate<string | null>(cdp, session, "typeof deskTest === 'object' && deskTest.panes().length > 0 ? deskTest.panes()[0] : null"), {
    label: "the panel's pane",
  });
  return { session, pane };
}

async function typeLine(cdp: Cdp, session: string, text: string): Promise<void> {
  await evaluate(cdp, session, "document.querySelector('textarea.xterm-helper-textarea')?.focus(), true");
  await cdp.send("Input.insertText", { text }, { sessionId: session });
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) }, { sessionId: session });
  }
}

const browserId = async () => (await browserVersion(PORT)).webSocketDebuggerUrl.split("/").pop() ?? "";

describe("desk reuses the Desk Chrome (slice 3b) in the live container", () => {
  beforeAll(async () => {
    installed = await installDesk({ port: PORT, resultTag: "reuse" });
    daemon = new UnixDaemonClient(join(installed.deskHome, "run", "ptyd.sock"), "0.0.1-dev.live+0000000");
    await launchDesk();
  }, 240_000);

  afterAll(async () => {
    if (installed === undefined) return;
    await runAnswering(join(installed.home, ".local", "bin", "desk"), ["quit", "--all"], userEnv(installed.home), "y").catch(() => undefined);
  }, 60_000);

  it(
    "desk on a running Desk Chrome reuses it: the same Chrome, and no second panel",
    async () => {
      const pid = await chromePid();
      const id = await browserId();

      const again = await launchDesk();
      const cdp = await Cdp.connect((await browserVersion(PORT)).webSocketDebuggerUrl);
      const panels = (await targets(cdp)).filter((t) => t.url.startsWith(PANEL_URL)).length;
      cdp.close();
      await saveResult("reuse-running", { again, pid, after: await chromePid(), id, idAfter: await browserId(), panels });

      expect(await chromePid()).toBe(pid);
      expect(await browserId()).toBe(id);
      expect(panels).toBe(1);
    },
    120_000,
  );

  it(
    "desk reuses a Chrome whose service worker was stopped",
    async () => {
      const cdp = await Cdp.connect((await browserVersion(PORT)).webSocketDebuggerUrl);
      const before = await panes();
      // Stop every service worker of the profile from a tab's DevTools session, as chrome://inspect's "stop" does.
      const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true });
      const tab = await attach(cdp, targetId);
      await cdp.send("ServiceWorker.enable", {}, { sessionId: tab });
      await cdp.send("ServiceWorker.stopAllWorkers", {}, { sessionId: tab });
      const stopped = await waitFor(async () => ((await panes())?.sw.connected === false ? true : null), { label: "the worker's native port closing", timeoutMs: 15_000 }).catch(
        (err: unknown) => String(err),
      );
      await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
      const workerWhileStopped = (await targets(cdp)).some((t) => t.type === "service_worker" && t.url === WORKER_URL);
      cdp.close();

      const run = await desk().desk();
      const after = await panes();
      await saveResult("reuse-worker-stopped", { before: before?.sw, stopped, workerWhileStopped, run, after: after?.sw });

      expect(stopped).toBe(true);
      expect(run.code).toBe(0);
      expect(after?.sw.connected).toBe(true);
      expect(after?.sw.connects).toBeGreaterThan(before?.sw.connects ?? 0);
    },
    120_000,
  );

  it(
    "closing the last window and running desk brings back a window with the panel and every pane re-attached",
    async () => {
      let cdp = await Cdp.connect((await browserVersion(PORT)).webSocketDebuggerUrl);
      const first = await panel(cdp);
      const shellPid = async (session: string, pane: string, tag: string): Promise<string> => {
        await typeLine(cdp, session, `echo ${tag}-$$`);
        return waitFor(
          async () => new RegExp(`^${tag}-(\\d+)$`, "m").exec(await evaluate<string>(cdp, session, `deskTest.screen(${JSON.stringify(pane)})`))?.[1] ?? null,
          { label: `the shell's pid (${tag})` },
        );
      };
      const pidBefore = await shellPid(first.session, first.pane, "before-the-last-window");
      const listed = await panes();
      for (const page of (await targets(cdp)).filter((t) => t.type === "page")) await cdp.send("Target.closeTarget", { targetId: page.targetId }).catch(() => undefined);
      cdp.close();
      // On Linux Chrome quits with its last window; on macOS it keeps running without one, and desk opens a window.
      await waitFor(async () => (await browserVersion(PORT).then(() => false, () => true)) || ((await panes())?.panels.length ?? 0) === 0 || null, {
        label: "the last window closed",
        timeoutMs: 20_000,
      });

      const run = await launchDesk();
      cdp = await Cdp.connect((await browserVersion(PORT)).webSocketDebuggerUrl);
      const second = await panel(cdp);
      const pidAfter = await shellPid(second.session, second.pane, "after-the-last-window");
      const after = await panes();
      cdp.close();
      await saveResult("reuse-last-window", { run, before: listed?.panes, after: after?.panes, pane: second.pane, pidBefore, pidAfter });

      expect(second.pane).toBe(first.pane);
      expect(pidAfter).toBe(pidBefore);
      expect(after?.panes.filter((pane) => pane.alive).map((pane) => pane.id).sort()).toEqual(listed?.panes.filter((pane) => pane.alive).map((pane) => pane.id).sort());
    },
    120_000,
  );
});
