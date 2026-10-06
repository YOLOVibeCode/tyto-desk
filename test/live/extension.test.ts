import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extensionIdFromKey } from "../../packages/core/src/index.ts";
import { attach, evaluate, targets, waitFor, type TargetInfo } from "./lib/cdp.ts";
import { startDeskChrome, type LiveChrome } from "./lib/chrome.ts";
import { installEchoHost } from "./lib/native-host.ts";
import { saveResult, saveScreenshot } from "./lib/results.ts";

const PORT = 9417;
const EXTENSION = fileURLToPath(new URL("./fixtures/extension", import.meta.url));
const HOST = "com.noctusoft.desk.live_echo";

const manifest: { key: string } = JSON.parse(await readFile(`${EXTENSION}/manifest.json`, "utf8"));
const keyId = extensionIdFromKey(manifest.key);

describe("the Desk extension in branded Chrome", () => {
  let chrome: LiveChrome;
  /** What Extensions.loadUnpacked answered: the id, or the CDP error. */
  let loaded: { id: string } | { error: string };

  beforeAll(async () => {
    chrome = await startDeskChrome({
      name: "extension",
      port: PORT,
      seedFirstRun: true,
      // Chrome reads <user-data-dir>/NativeMessagingHosts, so the host is registered before launch, for the key's id.
      beforeLaunch: (userDataDir) => installEchoHost({ userDataDir, name: HOST, origin: `chrome-extension://${keyId}/` }),
    });
    loaded = await chrome.cdp
      .send<{ id: string }>("Extensions.loadUnpacked", { path: EXTENSION }, { timeoutMs: 10_000 })
      .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
  });

  afterAll(async () => {
    expect(await chrome.close()).toEqual({ code: 0, signal: null });
  });

  /** The extension's service worker, once Chrome runs it. */
  const serviceWorker = (): Promise<TargetInfo> =>
    waitFor(async () => (await targets(chrome.cdp)).find((t) => t.type === "service_worker" && t.url === `chrome-extension://${keyId}/sw.js`), {
      label: "the extension's service worker",
    });

  it("Extensions.loadUnpacked loads the extension under the id derived from its manifest key", async () => {
    await saveResult("extension-load", { loaded, keyId });

    expect(loaded).toEqual({ id: keyId });
    expect((await serviceWorker()).url).toBe(`chrome-extension://${keyId}/sw.js`);
  });

  it("Extensions.triggerAction on a tab target opens the side panel on the left", async () => {
    const worker = await attach(chrome.cdp, (await serviceWorker()).targetId);
    await waitFor(() => evaluate<boolean>(chrome.cdp, worker, "chrome.sidePanel.getPanelBehavior().then((b) => b.openPanelOnActionClick)"), {
      label: "the worker's panel behavior",
    });
    const [tab] = (await chrome.cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets", { filter: [{ type: "tab" }] })).targetInfos;
    if (tab === undefined) throw new Error("Chrome has no tab target");

    await chrome.cdp.send("Extensions.triggerAction", { id: keyId, targetId: tab.targetId });
    const panel = await waitFor(async () => (await targets(chrome.cdp)).find((t) => t.url === `chrome-extension://${keyId}/panel.html`), {
      label: "the side panel",
    });
    const session = await attach(chrome.cdp, panel.targetId);
    await waitFor(() => evaluate<boolean>(chrome.cdp, session, "document.readyState === 'complete'"), { label: "the panel page" });
    const layout = await evaluate<{ side: string }>(chrome.cdp, session, "chrome.sidePanel.getLayout()");
    await saveScreenshot("extension-panel", (await chrome.cdp.send<{ data: string }>("Page.captureScreenshot", {}, { sessionId: session })).data);
    await saveResult("extension-panel", { panel: { type: panel.type, url: panel.url }, layout });

    expect(panel.type).toBe("page");
    expect(layout).toEqual({ side: "left" });
  });

  it("the native host starts with the extension origin as its first argument", async () => {
    const worker = await attach(chrome.cdp, (await serviceWorker()).targetId);
    const reply = await evaluate<{ echo: unknown; argv: string[] }>(
      chrome.cdp,
      worker,
      `chrome.runtime.sendNativeMessage(${JSON.stringify(HOST)}, { ping: "desk-live" })`,
    );
    await saveResult("extension-native-host", { reply });

    expect(reply.echo).toEqual({ ping: "desk-live" });
    expect(reply.argv[0]).toBe(`chrome-extension://${keyId}/`);
  });
});
