import { describe, expect, it } from "vitest";
import { CdpBrowserConnector, CdpConnection, CdpDeskExtension, CdpPanelOpener, openWebSocket } from "../src/index.ts";
import { FakeCdp } from "./fake-cdp.ts";

const EXTENSION_ID = "nmnljgjkacmplpfllopodplgmpjogdbf";

describe("the Desk extension over CDP", () => {
  it("DeskExtension reads the installed version from Extensions.getExtensions", async () => {
    const transport = new FakeCdp().on("Extensions.getExtensions", () => ({
      extensions: [{ id: "abcdefghijklmnopabcdefghijklmnop", version: "1.0" }, { id: EXTENSION_ID, version: "0.3.1.4" }],
    }));

    expect(await new CdpDeskExtension(new CdpConnection(transport)).installedVersion(EXTENSION_ID)).toBe("0.3.1.4");
  });

  it("DeskExtension reports no version when Chrome lists no such extension or cannot list them", async () => {
    const none = new FakeCdp().on("Extensions.getExtensions", () => ({ extensions: [] }));
    const refused = new FakeCdp().on("Extensions.getExtensions", () => {
      throw new Error("'Extensions.getExtensions' wasn't found");
    });

    expect(await new CdpDeskExtension(new CdpConnection(none)).installedVersion(EXTENSION_ID)).toBeNull();
    expect(await new CdpDeskExtension(new CdpConnection(refused)).installedVersion(EXTENSION_ID)).toBeNull();
  });

  it("DeskExtension loads the unpacked extension over the browser session and returns the id Chrome gave it", async () => {
    const transport = new FakeCdp().on("Extensions.loadUnpacked", (params) => ({ id: params.path === "/Users/alex/.desk/extension" ? EXTENSION_ID : "wrong" }));

    expect(await new CdpDeskExtension(new CdpConnection(transport)).load("/Users/alex/.desk/extension")).toEqual({ ok: true, id: EXTENSION_ID });
    expect(transport.sent).toEqual([{ method: "Extensions.loadUnpacked", params: { path: "/Users/alex/.desk/extension" } }]);
  });

  it("DeskExtension reports a refused load", async () => {
    const transport = new FakeCdp().on("Extensions.loadUnpacked", () => {
      throw new Error("Method not available.");
    });

    expect(await new CdpDeskExtension(new CdpConnection(transport)).load("/x")).toEqual({ ok: false, reason: "refused" });
  });
});

describe("the panel opener over CDP", () => {
  const tabs = new FakeCdp()
    .on("Target.getTargets", () => ({
      targetInfos: [
        { targetId: "TAB-A", type: "tab", url: "https://a.example/" },
        { targetId: "TAB-B", type: "tab", url: "https://b.example/" },
      ],
    }))
    .on("Browser.getWindowForTarget", (params) => ({ windowId: params.targetId === "TAB-A" ? 7 : 8, bounds: {} }));

  it("PanelOpener finds a tab target in a window by Browser.getWindowForTarget", async () => {
    const opener = new CdpPanelOpener(new CdpConnection(tabs));

    expect(await opener.tabTargetInWindow(8)).toBe("TAB-B");
    expect(await opener.tabTargetInWindow(9)).toBeNull();
    expect(tabs.sent.find((entry) => entry.method === "Target.getTargets")?.params).toEqual({ filter: [{ type: "tab" }] });
  });

  it("PanelOpener falls back to a page target of the window when Chrome places no tab target in it", async () => {
    const transport = new FakeCdp()
      .on("Target.getTargets", (params) =>
        params.filter === undefined
          ? { targetInfos: [{ targetId: "PANEL", type: "page", url: "chrome-extension://x/panel.html" }, { targetId: "PAGE-B", type: "page", url: "https://b.example/" }] }
          : { targetInfos: [{ targetId: "TAB-A", type: "tab", url: "https://a.example/" }] },
      )
      .on("Browser.getWindowForTarget", (params) => {
        if (params.targetId === "TAB-A") throw new Error("No web contents for the given target id");
        return { windowId: params.targetId === "PAGE-B" ? 8 : 9, bounds: {} };
      });

    expect(await new CdpPanelOpener(new CdpConnection(transport)).tabTargetInWindow(8)).toBe("PAGE-B");
  });

  it("PanelOpener finds any tab target", async () => {
    expect(await new CdpPanelOpener(new CdpConnection(tabs)).anyTabTarget()).toBe("TAB-A");
  });

  it("PanelOpener opens the panel by running the extension's toolbar action on the tab target", async () => {
    const transport = new FakeCdp().on("Extensions.triggerAction", () => ({}));

    expect(await new CdpPanelOpener(new CdpConnection(transport)).open(EXTENSION_ID, "TAB-B")).toBe(true);
    expect(transport.sent).toEqual([{ method: "Extensions.triggerAction", params: { id: EXTENSION_ID, targetId: "TAB-B" } }]);
  });

  it("PanelOpener opens a new normal window with Target.createTarget", async () => {
    const transport = new FakeCdp().on("Target.createTarget", () => ({ targetId: "PAGE-1" }));

    expect(await new CdpPanelOpener(new CdpConnection(transport)).newWindow()).toBe(true);
    expect(transport.sent).toEqual([{ method: "Target.createTarget", params: { url: "about:blank", newWindow: true } }]);
  });
});

describe("the browser connector", () => {
  it.each([
    ["on another host", "ws://10.0.0.5:39417/devtools/browser/0f1e2d3c"],
    ["on localhost by name", "ws://localhost:39417/devtools/browser/0f1e2d3c"],
    ["over TLS", "wss://127.0.0.1:39417/devtools/browser/0f1e2d3c"],
    ["for a page rather than the browser", "ws://127.0.0.1:39417/devtools/page/0f1e2d3c"],
    ["with credentials", "ws://desk@127.0.0.1:39417/devtools/browser/0f1e2d3c"],
    ["with no port", "ws://127.0.0.1/devtools/browser/0f1e2d3c"],
  ])("the browser connector refuses a WebSocket URL %s, before it opens anything", async (_label, wsUrl) => {
    expect(await new CdpBrowserConnector().connect(wsUrl)).toEqual({ ok: false });
  });

  it.each([9222, 9229, 9400, 9417, 9899])(
    "the browser connector refuses port %i under Vitest before it opens a WebSocket, so no test reaches the operator's Chrome",
    async (port) => {
      await expect(new CdpBrowserConnector().connect(`ws://127.0.0.1:${port}/devtools/browser/0f1e2d3c`)).rejects.toThrow(
        new RegExp(`reserved port ${port}`),
      );
    },
  );

  it("opening a CDP WebSocket refuses a reserved port under Vitest, whoever asks", () => {
    expect(() => openWebSocket("ws://127.0.0.1:9417/devtools/browser/0f1e2d3c")).toThrow(/reserved port 9417/);
  });
});
