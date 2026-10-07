import { STATUS_CODES, createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  GatewayConnection,
  HiddenTargets,
  type GatewayStep,
  filterTargetList,
  guardedVersion,
  httpGuard,
  isDeskUrl,
  routeGatewayHttp,
  type GuardedEndpoint,
} from "@desk/core";
import { assertPortAllowed } from "@desk/node";
import { rawRequest } from "./raw-http.ts";
import { TargetFeed } from "./target-feed.ts";

export type EndpointOptions = {
  /** `config.gateway.port`; 0 lets the system choose (tests). */
  port: number;
  /** The Desk Chrome's raw debugging port. */
  rawPort: number;
  extensionId: string;
  /** The first wait before the discovery connection retries (100 ms; tests shorten it). */
  feedRetryMs?: number;
  /** §12's focus guard: agents' new tabs open in the background, and only the tab you look at may be brought forward. */
  focusGuard?: boolean;
  /** The target id of the active tab in the last-focused Desk window, from the service worker; `null` when it did not say. */
  activeTab?: () => Promise<string | null>;
};

const NOT_RUNNING = "Desk is not running; run desk";

function text(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function send(res: ServerResponse, status: number, body: string | Buffer, contentType = "text/plain; charset=UTF-8"): void {
  res.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/** Ends an upgrade that will not become a WebSocket with a bare HTTP status. */
function refuseUpgrade(socket: Duplex, status: number): void {
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * The guarded endpoint (docs/IMPLEMENTATION.md §12) on `127.0.0.1:<gateway port>`, hosted by `desk watch`. Every
 * request passes `httpGuard` (any Origin → 403, a foreign Host → 500) and gets no CORS headers. HTTP mirrors Chrome's
 * DevTools endpoints with Desk's targets hidden and debugger URLs pointed here; each WebSocket client gets its own
 * upstream socket on the raw port, so ids need no remapping, through core's `GatewayConnection`. While the discovery
 * connection is down, everything answers 503, so no other program can take the port meanwhile.
 */
export class NodeGuardedEndpoint implements GuardedEndpoint {
  private readonly options: EndpointOptions;
  private readonly hidden: HiddenTargets;
  private readonly feed: TargetFeed;
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  private readonly clients = new Set<WebSocket>();
  private server: Server | null = null;
  private listeningPort = 0;

  constructor(options: EndpointOptions) {
    this.options = options;
    this.hidden = new HiddenTargets(options.extensionId);
    this.feed = new TargetFeed({ rawPort: options.rawPort, hidden: this.hidden, ...(options.feedRetryMs === undefined ? {} : { firstRetryMs: options.feedRetryMs }) });
  }

  /** The port it listens on (the system's choice when created with 0). */
  port(): number {
    return this.listeningPort;
  }

  address(): AddressInfo | null {
    const address = this.server?.address();
    return typeof address === "object" && address !== null ? { address: address.address, family: address.family, port: address.port } : null;
  }

  async listen(): Promise<{ ok: true } | { ok: false; reason: "port-taken" }> {
    if (this.options.port !== 0) assertPortAllowed(this.options.port);
    const server = createServer((req, res) => void this.http(req, res));
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(req, socket, head));
    const listened = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen({ host: "127.0.0.1", port: this.options.port }, () => resolve(true));
    });
    if (!listened) return { ok: false, reason: "port-taken" };
    this.server = server;
    this.listeningPort = (server.address() as AddressInfo).port;
    this.feed.start();
    return { ok: true };
  }

  async close(): Promise<void> {
    this.feed.stop();
    for (const client of this.clients) client.terminate();
    this.clients.clear();
    this.wss.close();
    const server = this.server;
    this.server = null;
    if (server === null) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private guard(req: IncomingMessage): { ok: true } | { ok: false; status: 403 | 500 } {
    return httpGuard({ port: this.listeningPort, host: req.headers.host, origin: req.headers.origin });
  }

  private async http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const guard = this.guard(req);
    if (!guard.ok) return send(res, guard.status, guard.status === 403 ? "Origin refused" : "Host refused");
    if (!this.feed.up) return send(res, 503, NOT_RUNNING);
    const path = req.url ?? "/";
    const ports = { rawPort: this.options.rawPort, gatewayPort: this.listeningPort };
    const route = routeGatewayHttp(req.method ?? "GET", path);
    switch (route.kind) {
      case "version":
      case "list":
      case "new": {
        if (route.kind === "new" && isDeskUrl(route.url, this.options.extensionId)) return send(res, 403, "Desk's guarded endpoint refuses that URL");
        const raw = await rawRequest(this.options.rawPort, route.kind === "new" ? "PUT" : "GET", route.kind === "version" ? "/json/version" : route.kind === "list" ? "/json/list" : path);
        if (raw === null) return send(res, 503, NOT_RUNNING);
        if (raw.status !== 200) return send(res, raw.status, raw.body, raw.contentType);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.body.toString("utf8"));
        } catch {
          return send(res, 502, "Chrome's answer was not JSON");
        }
        const shown =
          route.kind === "version"
            ? guardedVersion(typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}, ports)
            : route.kind === "list"
              ? filterTargetList(parsed, { ...ports, extensionId: this.options.extensionId })
              : (filterTargetList([parsed], { ...ports, extensionId: this.options.extensionId })[0] ?? {});
        return send(res, 200, JSON.stringify(shown), "application/json; charset=UTF-8");
      }
      case "activate":
      case "close":
        if (this.hidden.isHidden(route.targetId)) return send(res, 404, `No such target id: ${route.targetId}`);
        if (route.kind === "activate" && this.options.focusGuard === true && (await this.activeTab()) !== route.targetId) {
          return send(res, 200, "Target activated");
        }
        return this.forward(res, path);
      case "protocol":
      case "devtools":
        return this.forward(res, path);
      case "method-not-allowed":
        return send(res, 405, "Method Not Allowed");
      case "not-found":
        return send(res, 404, "Not Found");
      default: {
        const unreachable: never = route;
        return unreachable;
      }
    }
  }

  private async forward(res: ServerResponse, path: string): Promise<void> {
    const raw = await rawRequest(this.options.rawPort, "GET", path);
    if (raw === null) return send(res, 503, NOT_RUNNING);
    return send(res, raw.status, raw.body, raw.contentType);
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const guard = this.guard(req);
    if (!guard.ok) return refuseUpgrade(socket, guard.status);
    if (!this.feed.up) return refuseUpgrade(socket, 503);
    const path = req.url ?? "";
    const target = /^\/devtools\/(browser|page)\/([^/?#]+)$/.exec(path);
    if (target === null) return refuseUpgrade(socket, 404);
    if (target[1] === "page" && this.hidden.isHidden(target[2])) return refuseUpgrade(socket, 404);
    const upstream = new WebSocket(`ws://127.0.0.1:${this.options.rawPort}${path}`, { perMessageDeflate: false, handshakeTimeout: 3_000 });
    const failed = () => refuseUpgrade(socket, 502);
    upstream.once("unexpected-response", failed);
    upstream.once("error", failed);
    upstream.once("open", () => {
      upstream.off("unexpected-response", failed);
      upstream.off("error", failed);
      this.wss.handleUpgrade(req, socket, head, (client) => this.bridge(client, upstream));
    });
  }

  /** The active tab, as the service worker reports it; any failure counts as no active tab. */
  private async activeTab(): Promise<string | null> {
    try {
      return (await this.options.activeTab?.()) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Relays one client and its upstream socket through core's policy until either side closes. The client's messages are
   * handled one at a time, so a focus command held while the active tab is looked up keeps its place in the order.
   */
  private bridge(client: WebSocket, upstream: WebSocket): void {
    const policy = new GatewayConnection({ extensionId: this.options.extensionId, hidden: this.hidden, focusGuard: this.options.focusGuard === true });
    const deliver = (step: GatewayStep) => {
      for (const message of step.toChrome) if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
      for (const message of step.toClient) if (client.readyState === WebSocket.OPEN) client.send(message);
    };
    let queue: Promise<void> = Promise.resolve();
    this.clients.add(client);
    client.on("message", (data, isBinary) => {
      queue = queue
        .then(async () => {
          if (isBinary) return upstream.send(data, { binary: true });
          const step = policy.fromClient(text(data));
          deliver(step);
          if (step.focus !== undefined) deliver(policy.focusAnswer(step.focus, await this.activeTab()));
        })
        .catch(() => undefined);
    });
    upstream.on("message", (data, isBinary) => {
      if (isBinary) return client.send(data, { binary: true });
      deliver(policy.fromChrome(text(data)));
    });
    const end = () => {
      this.clients.delete(client);
      if (client.readyState === WebSocket.OPEN) client.close();
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
    };
    client.on("close", end);
    upstream.on("close", end);
    client.on("error", end);
    upstream.on("error", end);
  }
}
