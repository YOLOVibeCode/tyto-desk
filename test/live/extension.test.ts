import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extensionIdFromKey } from "../../packages/core/src/index.ts";
import { attach, evaluate, targets, waitFor, type TargetInfo } from "./lib/cdp.ts";
import { startDeskChrome, type LiveChrome } from "./lib/chrome.ts";
import { installEchoHost } from "./lib/native-host.ts";
import { LIVE_PORTS } from "./lib/ports.ts";
import { saveFile, saveResult, saveScreenshot } from "./lib/results.ts";
import { longestRun, readScreen, screenPng, type Screen } from "./lib/screen.ts";

const PORT = LIVE_PORTS.extension;
const EXTENSION = fileURLToPath(new URL("./fixtures/extension", import.meta.url));
const HOST = "com.noctusoft.desk.live_echo";
/** The fixture panel's background (panel.html), as Xvfb draws it. */
const PANEL_BACKGROUND: [number, number, number] = [0x11, 0x11, 0x11];

const manifest: { key: string } = JSON.parse(await readFile(`${EXTENSION}/manifest.json`, "utf8"));
const keyId = extensionIdFromKey(manifest.key);

type Bounds = { left: number; top: number; width: number; height: number };

describe("the Desk extension in branded Chrome", () => {
  let started: LiveChrome | undefined;
  /** What Extensions.loadUnpacked answered: the id, or the CDP error. */
  let loaded: { id: string } | { error: string } = { error: "beforeAll did not run" };

  /** The Chrome beforeAll started; a test fails with this, not a TypeError, when it did not start. */
  const chrome = (): LiveChrome => {
    if (started === undefined) throw new Error("Chrome did not start (see the beforeAll failure)");
    return started;
  };

  beforeAll(async () => {
    started = await startDeskChrome({
      name: "extension",
      port: PORT,
      seedFirstRun: true,
      // Chrome reads <user-data-dir>/NativeMessagingHosts, so the host is registered before launch, for the key's id.
      beforeLaunch: (userDataDir) => installEchoHost({ userDataDir, name: HOST, origin: `chrome-extension://${keyId}/` }),
    });
    loaded = await started.cdp
      .send<{ id: string }>("Extensions.loadUnpacked", { path: EXTENSION }, { timeoutMs: 10_000 })
      .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
  });

  afterAll(async () => {
    if (started !== undefined) expect(await started.close()).toEqual({ code: 0, signal: null });
  });

  /** The extension's service worker, once Chrome runs it. */
  const serviceWorker = (): Promise<TargetInfo> =>
    waitFor(async () => (await targets(chrome().cdp)).find((t) => t.type === "service_worker" && t.url === `chrome-extension://${keyId}/sw.js`), {
      label: "the extension's service worker",
    });

  it("Extensions.loadUnpacked loads the extension under the id derived from its manifest key", async () => {
    await saveResult("extension-load", { loaded, keyId });

    expect(loaded).toEqual({ id: keyId });
    expect((await serviceWorker()).url).toBe(`chrome-extension://${keyId}/sw.js`);
  });

  it("Extensions.triggerAction on a tab target opens the side panel on the left", async () => {
    const { cdp } = chrome();
    const worker = await attach(cdp, (await serviceWorker()).targetId);
    await waitFor(() => evaluate<boolean>(cdp, worker, "chrome.sidePanel.getPanelBehavior().then((b) => b.openPanelOnActionClick)"), {
      label: "the worker's panel behavior",
    });
    const [tab] = (await cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets", { filter: [{ type: "tab" }] })).targetInfos;
    if (tab === undefined) throw new Error("Chrome has no tab target");

    await cdp.send("Extensions.triggerAction", { id: keyId, targetId: tab.targetId });
    const panel = await waitFor(async () => (await targets(cdp)).find((t) => t.url === `chrome-extension://${keyId}/panel.html`), {
      label: "the side panel",
    });
    const session = await attach(cdp, panel.targetId);
    await waitFor(() => evaluate<boolean>(cdp, session, "document.readyState === 'complete'"), { label: "the panel page" });
    // What Chrome reports reads back the pref the first-run seed wrote; where the panel is drawn is on the screen.
    const layout = await evaluate<{ side: string }>(cdp, session, "chrome.sidePanel.getLayout()");
    const page = (await targets(cdp)).find((t) => t.type === "page" && !t.url.startsWith("chrome-extension://"));
    if (page === undefined) throw new Error("Chrome has no page target");
    const { bounds } = await cdp.send<{ bounds: Bounds }>("Browser.getWindowForTarget", { targetId: page.targetId });
    const panelWidth = await evaluate<number>(cdp, session, "innerWidth");
    const row = bounds.top + Math.round(bounds.height / 2);
    // The panel slides in: wait until the screen shows its whole width, the same in two reads in a row. The last screen
    // read is saved either way.
    const seen: { screen: Screen | null; run: [number, number] | null } = { screen: null, run: null };
    const drawn = await waitFor(
      async () => {
        const screen = await readScreen();
        const run = longestRun(screen, row, PANEL_BACKGROUND);
        const still = run !== null && seen.run !== null && run[0] === seen.run[0] && run[1] === seen.run[1];
        Object.assign(seen, { screen, run });
        return still && run !== null && Math.abs(run[1] - run[0] + 1 - panelWidth) <= 4 ? { screen, run } : null;
      },
      { label: `the whole panel (${panelWidth} px), drawn and still, on the screen`, intervalMs: 200 },
    ).finally(async () => {
      if (seen.screen !== null) await saveFile("extension-screen.png", screenPng(seen.screen));
      await saveResult("extension-panel-screen", { row, lastRun: seen.run, panelWidth });
    });
    await saveScreenshot("extension-panel", (await cdp.send<{ data: string }>("Page.captureScreenshot", {}, { sessionId: session })).data);
    await saveResult("extension-panel", {
      panel: { type: panel.type, url: panel.url },
      layout,
      window: bounds,
      panelOnScreen: { row, from: drawn.run[0], to: drawn.run[1], panelWidth },
    });

    expect(panel.type).toBe("page");
    expect(layout).toEqual({ side: "left" });
    expect(drawn.run[0] - bounds.left).toBeLessThan(40);
    expect(drawn.run[1] - bounds.left).toBeLessThan(bounds.width / 2);
  });

  it("the native host starts with the extension origin as its first argument", async () => {
    const { cdp } = chrome();
    const worker = await attach(cdp, (await serviceWorker()).targetId);
    const reply = await evaluate<{ echo: unknown; argv: string[] }>(
      cdp,
      worker,
      `chrome.runtime.sendNativeMessage(${JSON.stringify(HOST)}, { ping: "desk-live" })`,
    );
    await saveResult("extension-native-host", { reply });

    expect(reply.echo).toEqual({ ping: "desk-live" });
    expect(reply.argv[0]).toBe(`chrome-extension://${keyId}/`);
  });
});
