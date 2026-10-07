import type { DevToolsHttp } from "@desk/core";
import { assertPortAllowed } from "@desk/node";
import { browserEndpointPort } from "./endpoint.ts";

/**
 * `GET http://127.0.0.1:<port>/json/version` with a 2 s budget (§6.6), behind the test guard's port check. The browser
 * WebSocket it reports must be Chrome's browser endpoint on 127.0.0.1 and the same port, so whatever answers there can
 * never send Desk's launch to another program or another Chrome (D99).
 */
export class HttpDevTools implements DevToolsHttp {
  async version(port: number): Promise<{ browser: string; wsUrl: string } | null> {
    assertPortAllowed(port);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) return null;
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null) return null;
      const { Browser: browser, webSocketDebuggerUrl: wsUrl } = body as Record<string, unknown>;
      if (typeof browser !== "string" || typeof wsUrl !== "string" || browserEndpointPort(wsUrl) !== port) return null;
      return { browser, wsUrl };
    } catch {
      return null;
    }
  }
}
