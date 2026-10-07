import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESK_EXTENSION_ID } from "../../packages/core/src/index.ts";
import { Cdp, attach, evaluate, targets, waitFor, type TargetInfo } from "./lib/cdp.ts";
import { browserVersion, xdotool } from "./lib/chrome.ts";
import { installDesk, runAnswering, userEnv, type InstalledDesk } from "./lib/desk-run.ts";
import { startFixtureServer, type FixtureServer } from "./lib/fixture-server.ts";
import { LIVE_PORTS } from "./lib/ports.ts";
import { saveFile, saveResult } from "./lib/results.ts";

const PORT = LIVE_PORTS.watch;
const PANEL_URL = `chrome-extension://${DESK_EXTENSION_ID}/panel.html`;

let installed: InstalledDesk | undefined;
let fixture: FixtureServer | undefined;

function setup(): { installed: InstalledDesk; fixture: FixtureServer } {
  if (installed === undefined || fixture === undefined) throw new Error("Desk did not start (see the beforeAll failure)");
  return { installed, fixture };
}

const browserId = async () => (await browserVersion(PORT).catch(() => null))?.webSocketDebuggerUrl.split("/").pop() ?? null;
const connect = async () => Cdp.connect((await browserVersion(PORT)).webSocketDebuggerUrl);
const panelTarget = async (cdp: Cdp): Promise<TargetInfo | undefined> => (await targets(cdp)).find((t) => t.url.startsWith(PANEL_URL));

describe("desk watch (slice 3b) in the live container", () => {
  beforeAll(async () => {
    installed = await installDesk({ port: PORT, resultTag: "watch" });
    fixture = await startFixtureServer();
    const launch = await installed.desk();
    if (launch.code !== 0) throw new Error(`desk exited ${launch.code}: ${launch.stderr.trim()}`);
    // desk starts desk watch last and returns: wait until the watch follows this Chrome before restarting it.
    const log = join(installed.deskHome, "logs", "watch.log");
    await waitFor(async () => ((await readFile(log, "utf8").catch(() => "")).includes('"chrome-followed"') ? true : null), {
      label: "desk watch following Chrome",
      timeoutMs: 20_000,
    });
  }, 240_000);

  afterAll(async () => {
    await fixture?.close();
    if (installed === undefined) return;
    const logs = join(installed.deskHome, "logs");
    for (const name of await readdir(logs).catch(() => [])) await saveFile(`watch-log-${name}`, await readFile(join(logs, name)));
    await runAnswering(join(installed.home, ".local", "bin", "desk"), ["quit", "--all"], userEnv(installed.home), "y").catch(() => undefined);
  }, 60_000);

  it(
    "after chrome://restart the panel is back within 5 s",
    async () => {
      let cdp = await connect();
      const before = await browserId();
      expect(await panelTarget(cdp)).toBeDefined();
      await cdp.send("Target.createTarget", { url: "chrome://restart", background: true }).catch(() => undefined);
      cdp.close();

      const returned = await waitFor(async () => {
        const id = await browserId();
        return id !== null && id !== before ? Date.now() : null;
      }, { label: "Chrome back with a new browser id", timeoutMs: 30_000, intervalMs: 50 });
      cdp = await connect();
      const panelAt = await waitFor(async () => ((await panelTarget(cdp)) !== undefined ? Date.now() : null), {
        label: "the panel after chrome://restart",
        timeoutMs: 20_000,
        intervalMs: 50,
      });
      cdp.close();
      await saveResult("watch-restart", { before, after: await browserId(), panelMs: panelAt - returned });

      expect(panelAt - returned).toBeLessThanOrEqual(5_000);
    },
    120_000,
  );

  it(
    "a page input keeps its typed text while watch reopens the panel",
    async () => {
      const { fixture: server } = setup();
      const text = "typed while desk watch reopens the panel";
      let cdp = await connect();
      // The form in front: Chrome restores it after the restart, and the watch reopens the panel while it is typed in.
      await cdp.send("Target.createTarget", { url: `${server.origin}/form.html` });
      await waitFor(async () => ((await targets(cdp)).some((t) => t.url.endsWith("/form.html")) ? true : null), { label: "the form tab" });
      const before = await browserId();
      await cdp.send("Target.createTarget", { url: "chrome://restart", background: true }).catch(() => undefined);
      cdp.close();
      await waitFor(async () => {
        const id = await browserId();
        return id !== null && id !== before ? true : null;
      }, { label: "Chrome back", timeoutMs: 30_000, intervalMs: 50 });

      cdp = await connect();
      const form = await waitFor(async () => (await targets(cdp)).find((t) => t.url.endsWith("/form.html")) ?? null, { label: "the restored form" });
      const page = await attach(cdp, form.targetId);
      await waitFor(() => evaluate<boolean>(cdp, page, "document.readyState === 'complete' && document.querySelector('#q') !== null"), { label: "the form loaded" });
      const window = (await xdotool("search", "--onlyvisible", "--class", "google-chrome")).split("\n").filter(Boolean).at(-1);
      if (window !== undefined) await xdotool("windowfocus", "--sync", window);
      await evaluate(cdp, page, "document.querySelector('#q').focus(), true");
      const panelBefore = (await panelTarget(cdp)) !== undefined;
      const typingAt = Date.now();
      const typing = xdotool("type", "--delay", "80", text);
      const panelAt = await waitFor(async () => ((await panelTarget(cdp)) !== undefined ? Date.now() : null), { label: "the reopened panel", timeoutMs: 20_000 });
      await typing;
      const value = await evaluate<string>(cdp, page, "document.querySelector('#q').value");
      const reopened = await panelTarget(cdp);
      const panelSession = reopened === undefined ? null : await attach(cdp, reopened.targetId);
      const panelState =
        panelSession === null
          ? null
          : await evaluate<unknown>(cdp, panelSession, "({ url: location.href, answer: globalThis.deskFocusAnswer ?? null, hasFocus: document.hasFocus(), active: document.activeElement?.tagName ?? null })");
      cdp.close();
      await saveResult("watch-typing", { value, panelBefore, panelAfterTypingMs: panelAt - typingAt, typingMs: Date.now() - typingAt, panelState });

      expect(value).toBe(text);
    },
    120_000,
  );

  it(
    "desk watch brings back a panel whose renderer crashed",
    async () => {
      const cdp = await connect();
      const panel = await waitFor(() => panelTarget(cdp), { label: "the panel" });
      const session = await attach(cdp, panel.targetId);
      await waitFor(() => evaluate<boolean>(cdp, session, "typeof deskTest === 'object' && deskTest.panes().length > 0"), { label: "the panel's pane" });
      await cdp.send("Page.crash", {}, { sessionId: session }).catch(() => undefined);
      const reopened = await waitFor(
        async () => (await targets(cdp)).find((t) => t.url.startsWith(PANEL_URL) && t.targetId !== panel.targetId) ?? null,
        { label: "the reopened panel", timeoutMs: 20_000 },
      );
      const reopenedSession = await attach(cdp, reopened.targetId);
      const pane = await waitFor(() => evaluate<string | null>(cdp, reopenedSession, "typeof deskTest === 'object' && deskTest.panes().length > 0 ? deskTest.panes()[0] : null"), {
        label: "the reopened panel's pane",
      });
      cdp.close();
      await saveResult("watch-crash", { reopened: reopened.url, pane });

      expect(reopened.url.startsWith(PANEL_URL)).toBe(true);
    },
    120_000,
  );

  it(
    "attaching to the panel target raises the banner",
    async () => {
      const cdp = await connect();
      const panel = await waitFor(() => panelTarget(cdp), { label: "the panel" });
      const session = await attach(cdp, panel.targetId);
      const alert = await waitFor(
        async () => {
          const text = await evaluate<string>(cdp, session, "typeof deskTest === 'object' ? deskTest.alert() : ''");
          return text === "" ? null : text;
        },
        { label: "the terminal-attached alert", timeoutMs: 10_000 },
      );
      cdp.close();
      await saveResult("watch-attached", { alert });

      expect(alert).toBe("Something is attached to this terminal: DevTools, or a CDP client on the raw port");
    },
    60_000,
  );
});
