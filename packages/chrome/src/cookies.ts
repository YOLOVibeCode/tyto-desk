import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Cookie, CookieBrowser, CookieJar, DevToolsPortFile } from "@desk/core";
import { assertPathAllowed } from "@desk/node";
import { CdpConnection, openWebSocket, type CdpTransport } from "./cdp.ts";

/** A browser WebSocket on this machine: nothing else is ever dialed for cookies. */
const BROWSER_WS = /^ws:\/\/127\.0\.0\.1:(\d{1,5})\/devtools\/browser\/[A-Za-z0-9-]+$/;
/** `Storage.setCookies` takes this many at a time (§14 step 6). */
const BATCH = 500;
const COOKIE_CALL_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A CDP cookie as Desk keeps it, or `null` for anything else. */
function toCookie(value: unknown): Cookie | null {
  if (!isRecord(value)) return null;
  const { name, value: text, domain, path, expires, secure, httpOnly, sameSite, partitionKey, session } = value;
  if (typeof name !== "string" || typeof text !== "string" || typeof domain !== "string" || typeof path !== "string") return null;
  const cookie: Cookie = {
    name,
    value: text,
    domain,
    path,
    expires: session === true || typeof expires !== "number" ? -1 : expires,
    secure: secure === true,
    httpOnly: httpOnly === true,
  };
  if (sameSite === "Strict" || sameSite === "Lax" || sameSite === "None") cookie.sameSite = sameSite;
  if (isRecord(partitionKey) && typeof partitionKey.topLevelSite === "string" && typeof partitionKey.hasCrossSiteAncestor === "boolean") {
    cookie.partitionKey = { topLevelSite: partitionKey.topLevelSite, hasCrossSiteAncestor: partitionKey.hasCrossSiteAncestor };
  }
  return cookie;
}

/** A cookie as `Storage.setCookies` takes it; a session cookie has no expiry. */
function toParam(cookie: Cookie): Record<string, unknown> {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.expires === -1 ? {} : { expires: cookie.expires }),
    ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
    ...(cookie.partitionKey === undefined ? {} : { partitionKey: cookie.partitionKey }),
  };
}

/**
 * Cookies over a browser's CDP session (docs/IMPLEMENTATION.md §14): `Storage.getCookies` reads them all, and
 * `Storage.setCookies` writes them 500 at a time; a batch Chrome refuses is written one cookie at a time, so the counts
 * name exactly which failed. Only `ws://127.0.0.1:<port>/devtools/browser/<id>` is dialed. Cookies stay in memory.
 */
export class CdpCookieBrowser implements CookieBrowser {
  private readonly open: (url: string, timeoutMs: number) => Promise<CdpTransport | null>;

  constructor(open: (url: string, timeoutMs: number) => Promise<CdpTransport | null> = openWebSocket) {
    this.open = open;
  }

  async connect(wsUrl: string, timeoutMs: number): Promise<CookieJar | null> {
    if (!BROWSER_WS.test(wsUrl)) return null;
    const transport = await this.open(wsUrl, timeoutMs);
    if (transport === null) return null;
    const cdp = new CdpConnection(transport);
    return {
      read: async () => {
        const answer = await cdp.send("Storage.getCookies", {}, COOKIE_CALL_MS);
        if (!answer.ok || !Array.isArray(answer.result.cookies)) return null;
        return answer.result.cookies.flatMap((entry) => toCookie(entry) ?? []);
      },
      write: async (cookies) => {
        let set = 0;
        let failed = 0;
        for (let start = 0; start < cookies.length; start += BATCH) {
          const batch = cookies.slice(start, start + BATCH);
          const answer = await cdp.send("Storage.setCookies", { cookies: batch.map(toParam) }, COOKIE_CALL_MS);
          if (answer.ok) {
            set += batch.length;
            continue;
          }
          for (const cookie of batch) {
            if ((await cdp.send("Storage.setCookies", { cookies: [toParam(cookie)] }, COOKIE_CALL_MS)).ok) set += 1;
            else failed += 1;
          }
        }
        return { set, failed };
      },
      close: () => cdp.close(),
    };
  }
}

/** A profile's `DevToolsActivePort`: its first line the port, its second the browser path (§14 step 2). */
export class NodeDevToolsPortFile implements DevToolsPortFile {
  private readonly path: string;

  constructor(userDataDir: string) {
    this.path = join(userDataDir, "DevToolsActivePort");
  }

  async read(): Promise<{ port: number; path: string } | null> {
    await assertPathAllowed(this.path);
    const text = await readFile(this.path, "utf8").catch(() => null);
    if (text === null) return null;
    const [portLine, pathLine] = text.split("\n");
    const port = Number(portLine);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535 || pathLine === undefined || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(pathLine.trim())) return null;
    return { port, path: pathLine.trim() };
  }
}
