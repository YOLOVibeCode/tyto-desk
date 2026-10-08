import type { Cookie, CookieBrowser, CookieJar } from "../ports/cookie-browser.ts";

/** Browsers by WebSocket URL, each with its cookies; what was written, and how each connection was made. */
export class FakeCookieBrowser implements CookieBrowser {
  readonly jars = new Map<string, Cookie[]>();
  readonly written = new Map<string, Cookie[]>();
  readonly connects: { wsUrl: string; timeoutMs: number }[] = [];
  readonly closed: string[] = [];
  /** URLs that never connect (no Allow within the timeout). */
  readonly refusing = new Set<string>();

  async connect(wsUrl: string, timeoutMs: number): Promise<CookieJar | null> {
    this.connects.push({ wsUrl, timeoutMs });
    if (this.refusing.has(wsUrl)) return null;
    return {
      read: async () => [...(this.jars.get(wsUrl) ?? [])],
      write: async (cookies) => {
        this.written.set(wsUrl, [...(this.written.get(wsUrl) ?? []), ...cookies]);
        return { set: cookies.length, failed: 0 };
      },
      close: () => {
        this.closed.push(wsUrl);
      },
    };
  }
}
