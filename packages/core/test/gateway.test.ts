import { describe, expect, it } from "vitest";
import { GatewayConnection, HiddenTargets, filterTargetList, focusGuardOn, guardedVersion, routeGatewayHttp } from "../src/index.ts";

const DESK = "nmnljgjkacmplpfllopodplgmpjogdbf";
const PANEL = { targetId: "PANEL", type: "page", url: `chrome-extension://${DESK}/panel.html`, title: "Desk", attached: false };
const WORKER = { targetId: "WORKER", type: "service_worker", url: `chrome-extension://${DESK}/sw.js`, title: "", attached: false };
const PAGE = { targetId: "PAGE", type: "page", url: "https://app.example/", title: "App", attached: false };
const OTHER_EXTENSION = { targetId: "OTHER", type: "page", url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.html", title: "", attached: false };

/** A gateway connection whose registry knows the panel and the worker as Desk's; the focus guard is off unless asked. */
function connection(focusGuard = false) {
  const hidden = new HiddenTargets(DESK);
  for (const info of [PANEL, WORKER, PAGE, OTHER_EXTENSION]) hidden.observe(info);
  return { hidden, gateway: new GatewayConnection({ extensionId: DESK, hidden, focusGuard }) };
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

describe("the focus guard (docs/IMPLEMENTATION.md §12, slice 4b)", () => {
  it("the focus guard gives Target.createTarget without newWindow background: true", () => {
    const { gateway } = connection(true);

    const step = gateway.fromClient(json({ id: 5, method: "Target.createTarget", params: { url: "https://app.example/agent" } }));

    expect(parsed(step.toChrome)).toEqual([{ id: 5, method: "Target.createTarget", params: { url: "https://app.example/agent", background: true } }]);
  });

  it("the focus guard leaves a Target.createTarget for a new window as it is", () => {
    const { gateway } = connection(true);
    const text = json({ id: 6, method: "Target.createTarget", params: { url: "about:blank", newWindow: true } });

    expect(gateway.fromClient(text)).toEqual({ toChrome: [text], toClient: [] });
  });

  it("the focus guard answers {} to Target.activateTarget and Page.bringToFront for a tab that is not the active tab of the last-focused window", () => {
    const { gateway } = connection(true);
    gateway.fromClient(json({ id: 1, method: "Target.attachToTarget", params: { targetId: "PAGE", flatten: true } }));
    gateway.fromChrome(json({ id: 1, result: { sessionId: "S-PAGE" } }));

    const activate = gateway.fromClient(json({ id: 2, method: "Target.activateTarget", params: { targetId: "PAGE" } }));
    const front = gateway.fromClient(json({ id: 3, method: "Page.bringToFront", params: {}, sessionId: "S-PAGE" }));

    expect(activate.toChrome).toEqual([]);
    expect(activate.focus?.targetId).toBe("PAGE");
    expect(front.focus?.targetId).toBe("PAGE");
    expect(activate.focus === undefined ? null : gateway.focusAnswer(activate.focus, "USER-TAB")).toEqual({ toChrome: [], toClient: [json({ id: 2, result: {} })] });
    expect(front.focus === undefined ? null : gateway.focusAnswer(front.focus, "USER-TAB")).toEqual({ toChrome: [], toClient: [json({ id: 3, sessionId: "S-PAGE", result: {} })] });
  });

  it("the focus guard passes Target.activateTarget and Page.bringToFront for the tab already active in the last-focused window", () => {
    const { gateway } = connection(true);
    gateway.fromChrome(json({ method: "Target.attachedToTarget", params: { sessionId: "S-AUTO", targetInfo: PAGE, waitingForDebugger: false } }));
    const activateText = json({ id: 2, method: "Target.activateTarget", params: { targetId: "PAGE" } });
    const frontText = json({ id: 3, method: "Page.bringToFront", params: {}, sessionId: "S-AUTO" });

    const activate = gateway.fromClient(activateText);
    const front = gateway.fromClient(frontText);

    expect(activate.focus === undefined ? null : gateway.focusAnswer(activate.focus, "PAGE")).toEqual({ toChrome: [activateText], toClient: [] });
    expect(front.focus === undefined ? null : gateway.focusAnswer(front.focus, "PAGE")).toEqual({ toChrome: [frontText], toClient: [] });
  });

  it("the focus guard treats a window list the worker does not answer as no active tab", () => {
    const { gateway } = connection(true);

    const step = gateway.fromClient(json({ id: 4, method: "Target.activateTarget", params: { targetId: "PAGE" } }));

    expect(step.focus === undefined ? null : gateway.focusAnswer(step.focus, null)).toEqual({ toChrome: [], toClient: [json({ id: 4, result: {} })] });
  });

  it("the focus guard swallows Page.bringToFront on a session whose target it never learned", () => {
    const { gateway } = connection(true);

    const step = gateway.fromClient(json({ id: 9, method: "Page.bringToFront", params: {}, sessionId: "S-UNKNOWN" }));

    expect(step.focus?.targetId).toBeNull();
    expect(step.focus === undefined ? null : gateway.focusAnswer(step.focus, "PAGE").toClient).toEqual([json({ id: 9, sessionId: "S-UNKNOWN", result: {} })]);
  });

  it("the focus guard turns on focus emulation for a page session a client attaches to, so input reaches a background tab", () => {
    const { gateway } = connection(true);
    gateway.fromClient(json({ id: 1, method: "Target.attachToTarget", params: { targetId: "PAGE", flatten: true } }));

    const step = gateway.fromChrome(json({ id: 1, result: { sessionId: "S-PAGE" } }));
    const sent = parsed(step.toChrome);

    expect(step.toClient).toEqual([json({ id: 1, result: { sessionId: "S-PAGE" } })]);
    expect(sent.map((m) => [m.method, m.params, m.sessionId])).toEqual([["Emulation.setFocusEmulationEnabled", { enabled: true }, "S-PAGE"]]);
    expect(gateway.fromChrome(json({ id: sent[0]?.id, sessionId: "S-PAGE", result: {} })).toClient).toEqual([]);
  });

  it("the focus guard turns on focus emulation for a page session an auto-attach opens", () => {
    const { gateway } = connection(true);
    const event = json({ method: "Target.attachedToTarget", params: { sessionId: "S-AUTO", targetInfo: PAGE, waitingForDebugger: true } });

    const step = gateway.fromChrome(event);

    expect(step.toClient).toEqual([event]);
    expect(parsed(step.toChrome).map((m) => [m.method, m.sessionId])).toEqual([["Emulation.setFocusEmulationEnabled", "S-AUTO"]]);
  });

  it("the focus guard answers a plain Page.captureScreenshot with the first screencast frame, which Chrome paints for a background tab", () => {
    const { gateway } = connection(true);

    const asked = gateway.fromClient(json({ id: 8, method: "Page.captureScreenshot", params: { format: "png" }, sessionId: "S-PAGE" }));
    const started = parsed(asked.toChrome);
    const frame = gateway.fromChrome(json({ method: "Page.screencastFrame", params: { data: "iVBORw0K", metadata: {}, sessionId: 4 }, sessionId: "S-PAGE" }));
    const late = gateway.fromChrome(json({ method: "Page.screencastFrame", params: { data: "late", metadata: {}, sessionId: 5 }, sessionId: "S-PAGE" }));

    expect(asked.toClient).toEqual([]);
    expect(started.map((m) => [m.method, m.params, m.sessionId])).toEqual([["Page.startScreencast", { format: "png", everyNthFrame: 1 }, "S-PAGE"]]);
    expect(frame.toClient).toEqual([json({ id: 8, sessionId: "S-PAGE", result: { data: "iVBORw0K" } })]);
    expect(parsed(frame.toChrome).map((m) => [m.method, m.params])).toEqual([
      ["Page.screencastFrameAck", { sessionId: 4 }],
      ["Page.stopScreencast", {}],
    ]);
    expect(late.toClient).toEqual([]);
  });

  it.each([
    ["a clip", { format: "png", clip: { x: 0, y: 0, width: 10, height: 10, scale: 1 } }],
    ["beyond the viewport", { format: "png", captureBeyondViewport: true }],
    ["in webp", { format: "webp" }],
  ])("the focus guard asks Chrome to capture a screenshot with %s from the view", (_, params) => {
    const { gateway } = connection(true);

    const step = gateway.fromClient(json({ id: 9, method: "Page.captureScreenshot", params, sessionId: "S-PAGE" }));

    expect(parsed(step.toChrome)).toEqual([{ id: 9, method: "Page.captureScreenshot", params: { ...params, fromSurface: false }, sessionId: "S-PAGE" }]);
  });

  it("the focus guard leaves the screencast frames of a screencast the client started itself alone", () => {
    const { gateway } = connection(true);
    gateway.fromClient(json({ id: 10, method: "Page.startScreencast", params: { format: "jpeg" }, sessionId: "S-PAGE" }));
    const frame = json({ method: "Page.screencastFrame", params: { data: "abc", metadata: {}, sessionId: 1 }, sessionId: "S-PAGE" });

    expect(gateway.fromChrome(frame)).toEqual({ toChrome: [], toClient: [frame] });
  });

  it.each([
    ["Target.createTarget", { url: "https://app.example/agent" }, undefined],
    ["Target.activateTarget", { targetId: "PAGE" }, undefined],
    ["Page.bringToFront", {}, "S-PAGE"],
    ["Page.captureScreenshot", { format: "png" }, "S-PAGE"],
  ])("with focusGuard off every focus method passes unchanged (%s)", (method, params, sessionId) => {
    const { gateway } = connection(false);
    const text = json({ id: 7, method, params, ...(sessionId === undefined ? {} : { sessionId }) });

    expect(gateway.fromClient(text)).toEqual({ toChrome: [text], toClient: [] });
  });
});

describe("the focus guard's setting (config gateway.focusGuard)", () => {
  it.each([
    ["on", true],
    ["auto", true],
    ["off", false],
  ] as const)("focusGuard %s turns the guard %s", (mode, on) => {
    expect(focusGuardOn(mode)).toBe(on);
  });
});
