import { describe, expect, it } from "vitest";
import { GatewayConnection, HiddenTargets, filterTargetList, guardedVersion, routeGatewayHttp } from "../src/index.ts";

const DESK = "nmnljgjkacmplpfllopodplgmpjogdbf";
const PANEL = { targetId: "PANEL", type: "page", url: `chrome-extension://${DESK}/panel.html`, title: "Desk", attached: false };
const WORKER = { targetId: "WORKER", type: "service_worker", url: `chrome-extension://${DESK}/sw.js`, title: "", attached: false };
const PAGE = { targetId: "PAGE", type: "page", url: "https://app.example/", title: "App", attached: false };
const OTHER_EXTENSION = { targetId: "OTHER", type: "page", url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.html", title: "", attached: false };

/** A gateway connection whose registry knows the panel and the worker as Desk's. */
function connection() {
  const hidden = new HiddenTargets(DESK);
  for (const info of [PANEL, WORKER, PAGE, OTHER_EXTENSION]) hidden.observe(info);
  return { hidden, gateway: new GatewayConnection({ extensionId: DESK, hidden }) };
}

const json = (value: unknown) => JSON.stringify(value);
const parsed = (texts: string[]) => texts.map((text) => JSON.parse(text) as Record<string, unknown>);

describe("the guarded endpoint's target policy (docs/IMPLEMENTATION.md §12)", () => {
  it("getTargets and target events never include a Desk extension target", () => {
    const { gateway } = connection();
    gateway.fromClient(json({ id: 1, method: "Target.getTargets", params: {} }));

    const answer = gateway.fromChrome(json({ id: 1, result: { targetInfos: [PANEL, PAGE, WORKER, OTHER_EXTENSION] } }));
    const events = [PANEL, WORKER].flatMap((info) =>
      ["Target.targetCreated", "Target.targetInfoChanged"].map((method) => gateway.fromChrome(json({ method, params: { targetInfo: info } })).toClient),
    );
    const destroyed = gateway.fromChrome(json({ method: "Target.targetDestroyed", params: { targetId: "PANEL" } })).toClient;
    const crashed = gateway.fromChrome(json({ method: "Target.targetCrashed", params: { targetId: "WORKER", status: "crashed", errorCode: 1 } })).toClient;

    expect(parsed(answer.toClient)).toEqual([{ id: 1, result: { targetInfos: [PAGE, OTHER_EXTENSION] } }]);
    expect(events.flat()).toEqual([]);
    expect(destroyed).toEqual([]);
    expect(crashed).toEqual([]);
  });

  it("the policy learns a new Desk target from Chrome's events, before any client can name it", () => {
    const hidden = new HiddenTargets(DESK);
    hidden.observe({ targetId: "LATER", url: `chrome-extension://${DESK}/panel.html` });

    expect(hidden.isHidden("LATER")).toBe(true);
    expect(hidden.isHidden("PAGE")).toBe(false);
  });

  it("an auto-attached Desk target is resumed and detached by the gateway and never shown", () => {
    const { gateway } = connection();

    const step = gateway.fromChrome(json({ method: "Target.attachedToTarget", params: { sessionId: "S-PANEL", targetInfo: PANEL, waitingForDebugger: true } }));
    const later = gateway.fromChrome(json({ method: "Runtime.consoleAPICalled", params: { type: "log", args: [] }, sessionId: "S-PANEL" }));
    const detached = gateway.fromChrome(json({ method: "Target.detachedFromTarget", params: { sessionId: "S-PANEL", targetId: "PANEL" } }));
    const sent = parsed(step.toChrome);

    expect(step.toClient).toEqual([]);
    expect(sent.map((message) => [message.method, message.params])).toEqual([
      ["Runtime.runIfWaitingForDebugger", {}],
      ["Target.detachFromTarget", { sessionId: "S-PANEL" }],
    ]);
    expect(sent[0]?.sessionId).toBe("S-PANEL");
    expect(later.toClient).toEqual([]);
    expect(detached.toClient).toEqual([]);
    for (const message of sent) expect(gateway.fromChrome(json({ id: message.id, result: {} })).toClient).toEqual([]);
  });

  it("a page target auto-attached on a client's own session reaches the client", () => {
    const { gateway } = connection();
    const event = json({ method: "Target.attachedToTarget", params: { sessionId: "S-PAGE", targetInfo: PAGE, waitingForDebugger: false } });

    expect(gateway.fromChrome(event)).toEqual({ toChrome: [], toClient: [event] });
  });

  it.each([
    ["Browser.close", {}],
    ["Browser.crash", {}],
    ["Browser.crashGpuProcess", {}],
    ["Extensions.loadUnpacked", { path: "/tmp/evil" }],
    ["Extensions.uninstall", { id: "abcdefghijklmnopabcdefghijklmnop" }],
    ["Extensions.getStorageItems", { id: DESK, storageArea: "local" }],
    ["Target.attachToTarget", { targetId: "PANEL", flatten: true }],
    ["Target.closeTarget", { targetId: "WORKER" }],
    ["Target.activateTarget", { targetId: "PANEL" }],
    ["Target.getTargetInfo", { targetId: "PANEL" }],
    ["Page.navigate", { url: `chrome-extension://${DESK}/panel.html` }],
    ["Target.createTarget", { url: `chrome-extension://${DESK.toUpperCase()}/panel.html` }],
  ])("it refuses %s at once with a CDP error", (method, params) => {
    const { gateway } = connection();

    const step = gateway.fromClient(json({ id: 7, method, params, sessionId: "S1" }));

    expect(step.toChrome).toEqual([]);
    expect(parsed(step.toClient)).toEqual([{ id: 7, sessionId: "S1", error: { code: -32000, message: `Desk's guarded endpoint refuses ${method} here; desk cdp --raw is the browser's own port` } }]);
  });

  it.each([
    ["Runtime.evaluate", { expression: "1 + 1" }],
    ["Network.getCookies", {}],
    ["Storage.getCookies", {}],
    ["Target.attachToTarget", { targetId: "PAGE", flatten: true }],
    ["Target.createTarget", { url: "https://app.example/next" }],
    ["Page.navigate", { url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.html" }],
    ["Extensions.getExtensions", {}],
  ])("every other method passes through unchanged (%s)", (method, params) => {
    const { gateway } = connection();
    const text = json({ id: 9, method, params });

    expect(gateway.fromClient(text)).toEqual({ toChrome: [text], toClient: [] });
  });

  it("answers and events about other targets pass through unchanged", () => {
    const { gateway } = connection();
    gateway.fromClient(json({ id: 3, method: "Runtime.evaluate", params: { expression: "1" } }));
    const answer = json({ id: 3, result: { result: { type: "number", value: 1 } } });
    const event = json({ method: "Target.targetCreated", params: { targetInfo: PAGE } });

    expect(gateway.fromChrome(answer)).toEqual({ toChrome: [], toClient: [answer] });
    expect(gateway.fromChrome(event)).toEqual({ toChrome: [], toClient: [event] });
  });

  it("a message that is not CDP JSON passes through untouched in both directions", () => {
    const { gateway } = connection();

    expect(gateway.fromClient("not json")).toEqual({ toChrome: ["not json"], toClient: [] });
    expect(gateway.fromChrome("not json")).toEqual({ toChrome: [], toClient: ["not json"] });
  });
});

describe("the guarded endpoint's HTTP routes (docs/IMPLEMENTATION.md §12)", () => {
  it("/json/version points at the guarded WebSocket", () => {
    const raw = { Browser: "Chrome/155.0.8059.40", "Protocol-Version": "1.3", webSocketDebuggerUrl: "ws://127.0.0.1:9417/devtools/browser/b-1" };

    expect(guardedVersion(raw, { rawPort: 9417, gatewayPort: 9583 })).toEqual({ ...raw, webSocketDebuggerUrl: "ws://127.0.0.1:9583/devtools/browser/b-1" });
  });

  it("/json/list hides Desk's targets and points every other one at the guarded endpoint", () => {
    const raw = [
      { id: "PANEL", type: "page", url: PANEL.url, webSocketDebuggerUrl: "ws://127.0.0.1:9417/devtools/page/PANEL" },
      {
        id: "PAGE",
        type: "page",
        url: PAGE.url,
        webSocketDebuggerUrl: "ws://127.0.0.1:9417/devtools/page/PAGE",
        devtoolsFrontendUrl: "/devtools/inspector.html?ws=127.0.0.1:9417/devtools/page/PAGE",
      },
    ];

    expect(filterTargetList(raw, { extensionId: DESK, rawPort: 9417, gatewayPort: 9583 })).toEqual([
      {
        id: "PAGE",
        type: "page",
        url: PAGE.url,
        webSocketDebuggerUrl: "ws://127.0.0.1:9583/devtools/page/PAGE",
        devtoolsFrontendUrl: "/devtools/inspector.html?ws=127.0.0.1:9583/devtools/page/PAGE",
      },
    ]);
  });

  it.each([
    ["GET", "/json/version", { kind: "version" }],
    ["GET", "/json/version/", { kind: "version" }],
    ["GET", "/json/", { kind: "list" }],
    ["GET", "/json/list/", { kind: "list" }],
    ["GET", "/json/activate/PAGE/", { kind: "activate", targetId: "PAGE" }],
    ["GET", "/json", { kind: "list" }],
    ["GET", "/json/list", { kind: "list" }],
    ["PUT", "/json/new?https://app.example/", { kind: "new", url: "https://app.example/" }],
    ["GET", "/json/activate/PAGE", { kind: "activate", targetId: "PAGE" }],
    ["GET", "/json/close/PAGE", { kind: "close", targetId: "PAGE" }],
    ["GET", "/devtools/inspector.html", { kind: "devtools" }],
    ["GET", "/json/protocol", { kind: "protocol" }],
    ["GET", "/somewhere", { kind: "not-found" }],
  ])("%s %s routes to %j", (method, path, route) => {
    expect(routeGatewayHttp(method, path)).toEqual(route);
  });

  it.each(["GET", "POST"])("/json/new answers only PUT (%s is refused)", (method) => {
    expect(routeGatewayHttp(method, "/json/new?https://app.example/")).toEqual({ kind: "method-not-allowed" });
  });
});
