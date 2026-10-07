import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export const DESK = "nmnljgjkacmplpfllopodplgmpjogdbf";
export const PANEL = { targetId: "PANEL", type: "page", url: `chrome-extension://${DESK}/panel.html`, title: "Desk", attached: false };
export const PAGE = { targetId: "PAGE", type: "page", url: "https://app.example/", title: "App", attached: false };

/**
 * A Chrome the tests play on an ephemeral 127.0.0.1 port: `/json/version`, `/json/list`, `/json/new` (PUT),
 * `/json/activate/<id>`, `/devtools/*`, and a browser WebSocket that answers `Target.setDiscoverTargets` with a
 * `targetCreated` for each target, `Target.getTargets` with both, and echoes any other command's method as its result.
 * It records every HTTP request and every command, and refuses an upgrade that carries an Origin, as Chrome does.
 */
export async function startFakeChrome() {
  const requests: { method: string; url: string; host: string | undefined }[] = [];
  const commands: Record<string, unknown>[] = [];
  const sockets = new Set<WebSocket>();
  let port = 0;
  const server: Server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", host: req.headers.host });
    const json = (value: unknown) => {
      res.writeHead(200, { "content-type": "application/json; charset=UTF-8" });
      res.end(JSON.stringify(value));
    };
    const ws = (id: string, kind: string) => `ws://127.0.0.1:${port}/devtools/${kind}/${id}`;
    if (req.url === "/json/version") return json({ Browser: "Chrome/155.0.8059.40", webSocketDebuggerUrl: ws("b-1", "browser") });
    if (req.url === "/json/list" || req.url === "/json") {
      return json([PANEL, PAGE].map((t) => ({ id: t.targetId, type: t.type, url: t.url, webSocketDebuggerUrl: ws(t.targetId, "page") })));
    }
    if (req.url?.startsWith("/json/new?") === true && req.method === "PUT") {
      return json({ id: "NEW", type: "page", url: decodeURIComponent(req.url.slice("/json/new?".length)), webSocketDebuggerUrl: ws("NEW", "page") });
    }
    if (req.url?.startsWith("/json/activate/") === true) {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("Target activated");
    }
    if (req.url?.startsWith("/devtools/") === true) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<!doctype html>devtools");
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    if (req.headers.origin !== undefined) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      sockets.add(client);
      client.on("close", () => sockets.delete(client));
      client.on("message", (data) => {
        const message = JSON.parse(String(data)) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
        commands.push(message);
        const reply = (value: unknown) => client.send(JSON.stringify(value));
        if (message.method === "Target.setDiscoverTargets") {
          for (const targetInfo of [PANEL, PAGE]) reply({ method: "Target.targetCreated", params: { targetInfo } });
          return reply({ id: message.id, result: {} });
        }
        if (message.method === "Target.getTargets") return reply({ id: message.id, result: { targetInfos: [PANEL, PAGE] } });
        reply({ id: message.id, result: { echoed: message.method }, ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }) });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    requests,
    commands,
    /** Chrome sends an event to every connected client. */
    emit(event: unknown): void {
      for (const socket of sockets) socket.send(JSON.stringify(event));
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
