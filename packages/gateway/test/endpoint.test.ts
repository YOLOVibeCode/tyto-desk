import { request } from "node:http";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { NodeGuardedEndpoint } from "../src/index.ts";
import { DESK, startFakeChrome } from "./fake-chrome.ts";

type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** One HTTP request to the endpoint on 127.0.0.1, with exactly the headers given (Host defaults to the right one). */
function http(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers }, signal: AbortSignal.timeout(5_000) }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A WebSocket client on the endpoint; resolves once open, or with the status Chrome's rules answered instead. */
function connect(url: string, options: { origin?: string } = {}): Promise<{ ok: true; socket: WebSocket } | { ok: false; status: number }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, options.origin === undefined ? {} : { origin: options.origin });
    socket.once("open", () => resolve({ ok: true, socket }));
    socket.once("unexpected-response", (_req, res) => resolve({ ok: false, status: res.statusCode ?? 0 }));
    socket.once("error", () => resolve({ ok: false, status: 0 }));
  });
}

/** Sends a command and resolves with the answer that carries its id. */
function command(socket: WebSocket, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const listener = (data: unknown) => {
      const answer = JSON.parse(String(data)) as Record<string, unknown>;
      if (answer.id === message.id) {
        socket.off("message", listener);
        resolve(answer);
      }
    };
    socket.on("message", listener);
    socket.send(JSON.stringify(message));
  });
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A fake Chrome and a guarded endpoint in front of it, on ephemeral ports, once the endpoint follows Chrome. */
async function guarded(focus: { activeTab: () => Promise<string | null> } | null = null) {
  const chrome = await startFakeChrome();
  cleanups.push(chrome.close);
  const endpoint = new NodeGuardedEndpoint({
    port: 0,
    rawPort: chrome.port,
    extensionId: DESK,
    feedRetryMs: 20,
    ...(focus === null ? {} : { focusGuard: true, activeTab: focus.activeTab }),
  });
  cleanups.push(() => endpoint.close());
  expect(await endpoint.listen()).toEqual({ ok: true });
  for (let i = 0; i < 200 && (await http(endpoint.port(), "GET", "/json/version")).status !== 200; i += 1) await new Promise((r) => setTimeout(r, 10));
  return { chrome, endpoint, port: endpoint.port() };
}

describe("the guarded endpoint over HTTP (docs/IMPLEMENTATION.md §12)", () => {
  it("the guarded endpoint listens on 127.0.0.1 only", async () => {
    const { endpoint } = await guarded();

    expect(endpoint.address()).toEqual({ address: "127.0.0.1", family: "IPv4", port: endpoint.port() });
  });

  it("it answers 500 to a Host that is not 127.0.0.1 or localhost", async () => {
    const { port } = await guarded();

    expect((await http(port, "GET", "/json/version", { host: `rebind.example:${port}` })).status).toBe(500);
    expect((await http(port, "GET", "/json/version", { host: `localhost:${port}` })).status).toBe(200);
  });

  it("it refuses a plain request with any Origin header (403)", async () => {
    const { port } = await guarded();

    expect((await http(port, "GET", "/json/version", { origin: "http://127.0.0.1:8080" })).status).toBe(403);
  });

  it("it sends no CORS headers", async () => {
    const { port } = await guarded();

    const answer = await http(port, "GET", "/json/list");

    expect(Object.keys(answer.headers).filter((name) => name.startsWith("access-control-"))).toEqual([]);
  });

  it("/json/version points at the guarded WebSocket", async () => {
    const { port } = await guarded();

    const version = JSON.parse((await http(port, "GET", "/json/version")).body) as Record<string, unknown>;

    expect(version.webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/devtools/browser/b-1`);
  });

  it("/json/list hides Desk's targets and points the others at the guarded endpoint", async () => {
    const { port } = await guarded();

    const list = JSON.parse((await http(port, "GET", "/json/list")).body) as Record<string, unknown>[];

    expect(list).toEqual([{ id: "PAGE", type: "page", url: "https://app.example/", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/PAGE` }]);
  });

  it("/json/new answers only PUT", async () => {
    const { port, chrome } = await guarded();

    const refused = await http(port, "GET", "/json/new?https://app.example/next");
    const made = await http(port, "PUT", "/json/new?https://app.example/next");

    expect(refused.status).toBe(405);
    expect(made.status).toBe(200);
    expect(JSON.parse(made.body)).toMatchObject({ id: "NEW", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/NEW` });
    expect(chrome.requests.filter((r) => r.url.startsWith("/json/new")).map((r) => r.method)).toEqual(["PUT"]);
  });

  it("/json/new refuses a Desk URL without asking Chrome", async () => {
    const { port, chrome } = await guarded();

    expect((await http(port, "PUT", `/json/new?chrome-extension://${DESK}/panel.html`)).status).toBe(403);
    expect(chrome.requests.filter((r) => r.url.startsWith("/json/new"))).toEqual([]);
  });

  it("/json/activate and /json/close refuse a Desk target, and pass any other", async () => {
    const { port } = await guarded();

    expect((await http(port, "GET", "/json/activate/PANEL")).status).toBe(404);
    expect((await http(port, "GET", "/json/close/PANEL")).status).toBe(404);
    expect((await http(port, "GET", "/json/activate/PAGE")).body).toBe("Target activated");
  });

  it("GET /devtools/* reaches Chrome's own DevTools files", async () => {
    const { port } = await guarded();

    expect((await http(port, "GET", "/devtools/inspector.html")).body).toBe("<!doctype html>devtools");
  });

  it("the endpoint asks Chrome with Chrome's own Host and never an Origin", async () => {
    const { port, chrome } = await guarded();

    await http(port, "GET", "/json/version");

    expect(chrome.requests.every((r) => r.host === `127.0.0.1:${chrome.port}`)).toBe(true);
  });

  it("it answers 503 while the Desk Chrome is down", async () => {
    const free = createServer();
    await new Promise<void>((resolve) => free.listen({ host: "127.0.0.1", port: 0 }, resolve));
    const rawPort = (free.address() as { port: number }).port;
    await new Promise<void>((resolve) => free.close(() => resolve()));
    const endpoint = new NodeGuardedEndpoint({ port: 0, rawPort, extensionId: DESK, feedRetryMs: 20 });
    cleanups.push(() => endpoint.close());
    await endpoint.listen();

    const answer = await http(endpoint.port(), "GET", "/json/version");
    const upgrade = await connect(`ws://127.0.0.1:${endpoint.port()}/devtools/browser/b-1`);

    expect(answer).toMatchObject({ status: 503, body: "Desk is not running; run desk" });
    expect(upgrade).toEqual({ ok: false, status: 503 });
  });

  it("listen says the port is taken when another program holds it", async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen({ host: "127.0.0.1", port: 0 }, resolve));
    cleanups.push(() => new Promise<void>((resolve) => holder.close(() => resolve())));
    const taken = (holder.address() as { port: number }).port;

    const endpoint = new NodeGuardedEndpoint({ port: taken, rawPort: 1, extensionId: DESK });

    expect(await endpoint.listen()).toEqual({ ok: false, reason: "port-taken" });
  });

  it("the endpoint refuses Desk's ports under Vitest, before it listens", async () => {
    await expect(new NodeGuardedEndpoint({ port: 9583, rawPort: 9417, extensionId: DESK }).listen()).rejects.toThrow(/reserved|refuse/i);
  });
});

describe("the guarded endpoint over WebSocket (docs/IMPLEMENTATION.md §12)", () => {
  it("it refuses a WebSocket upgrade with any Origin header (403)", async () => {
    const { port } = await guarded();

    expect(await connect(`ws://127.0.0.1:${port}/devtools/browser/b-1`, { origin: "http://127.0.0.1:8080" })).toEqual({ ok: false, status: 403 });
  });

  it("a client's Target.getTargets lists no Desk target", async () => {
    const { port } = await guarded();
    const opened = await connect(`ws://127.0.0.1:${port}/devtools/browser/b-1`);
    if (!opened.ok) throw new Error(`no connection: ${opened.status}`);
    cleanups.push(async () => opened.socket.close());

    const answer = await command(opened.socket, { id: 1, method: "Target.getTargets", params: {} });

    expect((answer.result as { targetInfos: { targetId: string }[] }).targetInfos.map((t) => t.targetId)).toEqual(["PAGE"]);
  });

  it("a client's Browser.close is refused at once and never reaches Chrome", async () => {
    const { port, chrome } = await guarded();
    const opened = await connect(`ws://127.0.0.1:${port}/devtools/browser/b-1`);
    if (!opened.ok) throw new Error(`no connection: ${opened.status}`);
    cleanups.push(async () => opened.socket.close());

    const answer = await command(opened.socket, { id: 2, method: "Browser.close", params: {} });

    expect(answer.error).toMatchObject({ code: -32000 });
    expect(chrome.commands.some((c) => c.method === "Browser.close")).toBe(false);
  });

  it("every other command reaches Chrome unchanged and its answer comes back", async () => {
    const { port, chrome } = await guarded();
    const opened = await connect(`ws://127.0.0.1:${port}/devtools/browser/b-1`);
    if (!opened.ok) throw new Error(`no connection: ${opened.status}`);
    cleanups.push(async () => opened.socket.close());

    const answer = await command(opened.socket, { id: 3, method: "Storage.getCookies", params: {} });

    expect(answer).toEqual({ id: 3, result: { echoed: "Storage.getCookies" } });
    expect(chrome.commands.at(-1)).toEqual({ id: 3, method: "Storage.getCookies", params: {} });
  });

  it("a Desk target's page WebSocket is refused", async () => {
    const { port } = await guarded();

    expect(await connect(`ws://127.0.0.1:${port}/devtools/page/PANEL`)).toEqual({ ok: false, status: 404 });
  });

  it("closing the endpoint ends its clients' connections", async () => {
    const { port, endpoint } = await guarded();
    const opened = await connect(`ws://127.0.0.1:${port}/devtools/browser/b-1`);
    if (!opened.ok) throw new Error(`no connection: ${opened.status}`);
    const closed = new Promise<void>((resolve) => opened.socket.once("close", () => resolve()));

    await endpoint.close();

    await closed;
    expect(opened.socket.readyState).toBe(WebSocket.CLOSED);
  });
});

describe("the focus guard in the guarded endpoint (docs/IMPLEMENTATION.md §12, slice 4b)", () => {
  async function client(port: number): Promise<WebSocket> {
    const opened = await connect(`ws://127.0.0.1:${port}/devtools/browser/b-1`);
    if (!opened.ok) throw new Error(`no connection: ${opened.status}`);
    cleanups.push(async () => opened.socket.close());
    return opened.socket;
  }

  it("a client's Target.createTarget reaches Chrome with background: true", async () => {
    const { port, chrome } = await guarded({ activeTab: async () => "USER" });

    await command(await client(port), { id: 1, method: "Target.createTarget", params: { url: "https://app.example/agent" } });

    expect(chrome.commands.find((c) => c.method === "Target.createTarget")).toEqual({
      id: 1,
      method: "Target.createTarget",
      params: { url: "https://app.example/agent", background: true },
    });
  });

  it("a client's Target.activateTarget for a tab you are not looking at is answered with {} and never reaches Chrome", async () => {
    const { port, chrome } = await guarded({ activeTab: async () => "USER" });

    const answer = await command(await client(port), { id: 2, method: "Target.activateTarget", params: { targetId: "PAGE" } });

    expect(answer).toEqual({ id: 2, result: {} });
    expect(chrome.commands.some((c) => c.method === "Target.activateTarget")).toBe(false);
  });

  it("a client's Target.activateTarget for the tab you are looking at reaches Chrome", async () => {
    const { port, chrome } = await guarded({ activeTab: async () => "PAGE" });

    const answer = await command(await client(port), { id: 3, method: "Target.activateTarget", params: { targetId: "PAGE" } });

    expect(answer).toEqual({ id: 3, result: { echoed: "Target.activateTarget" } });
    expect(chrome.commands.some((c) => c.method === "Target.activateTarget")).toBe(true);
  });

  it("commands after a held focus command reach Chrome in the order the client sent them", async () => {
    let release: (tab: string | null) => void = () => undefined;
    const { port, chrome } = await guarded({ activeTab: () => new Promise((resolve) => (release = resolve)) });
    const socket = await client(port);

    const held = command(socket, { id: 4, method: "Target.activateTarget", params: { targetId: "PAGE" } });
    const after = command(socket, { id: 5, method: "Runtime.evaluate", params: { expression: "1" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const beforeRelease = chrome.commands.filter((c) => c.id === 5).length;
    release("PAGE");
    await Promise.all([held, after]);

    expect(beforeRelease).toBe(0);
    expect(chrome.commands.filter((c) => c.id === 4 || c.id === 5).map((c) => c.id)).toEqual([4, 5]);
  });

  it("/json/activate/<id> goes through the focus guard", async () => {
    const { port, chrome } = await guarded({ activeTab: async () => "USER" });

    const answer = await http(port, "GET", "/json/activate/PAGE");

    expect(answer).toMatchObject({ status: 200, body: "Target activated" });
    expect(chrome.requests.some((r) => r.url.startsWith("/json/activate"))).toBe(false);
  });
});
