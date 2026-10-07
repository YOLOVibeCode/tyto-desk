import { isDeskUrl } from "./policy.ts";

/** What the guarded endpoint does with an HTTP request (§12). */
export type GatewayRoute =
  | { kind: "version" }
  | { kind: "list" }
  | { kind: "protocol" }
  | { kind: "new"; url: string }
  | { kind: "activate"; targetId: string }
  | { kind: "close"; targetId: string }
  | { kind: "devtools" }
  | { kind: "method-not-allowed" }
  | { kind: "not-found" };

/**
 * Chrome's DevTools HTTP endpoints, as the guarded endpoint serves them: `/json/version`, `/json` and `/json/list`,
 * `/json/protocol`, `/json/new` (PUT only, as Chrome itself requires), `/json/activate/<id>`, `/json/close/<id>`, and
 * `GET /devtools/*`, which agent-browser's `inspect` needs.
 */
export function routeGatewayHttp(method: string, path: string): GatewayRoute {
  const question = path.indexOf("?");
  const pathname = question === -1 ? path : path.slice(0, question);
  const query = question === -1 ? "" : path.slice(question + 1);
  if (pathname === "/json/new") return method === "PUT" ? { kind: "new", url: decodeURIComponent(query) } : { kind: "method-not-allowed" };
  if (method !== "GET") return { kind: "method-not-allowed" };
  if (pathname === "/json/version") return { kind: "version" };
  if (pathname === "/json" || pathname === "/json/list") return { kind: "list" };
  if (pathname === "/json/protocol") return { kind: "protocol" };
  const target = /^\/json\/(activate|close)\/([^/]+)$/.exec(pathname);
  if (target?.[1] !== undefined && target[2] !== undefined) {
    return { kind: target[1] === "activate" ? "activate" : "close", targetId: decodeURIComponent(target[2]) };
  }
  if (pathname.startsWith("/devtools/")) return { kind: "devtools" };
  return { kind: "not-found" };
}

type Ports = { rawPort: number; gatewayPort: number };

/** Points a debugger URL (`ws://127.0.0.1:<raw>/…`, or `ws=127.0.0.1:<raw>/…` in a frontend URL) at the guarded port. */
function guarded(value: unknown, ports: Ports): unknown {
  if (typeof value !== "string") return value;
  return value.split(`127.0.0.1:${ports.rawPort}/`).join(`127.0.0.1:${ports.gatewayPort}/`).split(`localhost:${ports.rawPort}/`).join(`127.0.0.1:${ports.gatewayPort}/`);
}

/** `/json/version` with its browser WebSocket pointed at the guarded endpoint. */
export function guardedVersion(raw: Record<string, unknown>, ports: Ports): Record<string, unknown> {
  return { ...raw, webSocketDebuggerUrl: guarded(raw.webSocketDebuggerUrl, ports) };
}

/** `/json/list` without Desk's targets, every other entry's debugger URLs pointed at the guarded endpoint. */
export function filterTargetList(raw: unknown, input: Ports & { extensionId: string }): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry))
    .filter((entry) => !isDeskUrl(entry.url, input.extensionId))
    .map((entry) => {
      const shown: Record<string, unknown> = { ...entry };
      if ("webSocketDebuggerUrl" in entry) shown.webSocketDebuggerUrl = guarded(entry.webSocketDebuggerUrl, input);
      if ("devtoolsFrontendUrl" in entry) shown.devtoolsFrontendUrl = guarded(entry.devtoolsFrontendUrl, input);
      return shown;
    });
}
