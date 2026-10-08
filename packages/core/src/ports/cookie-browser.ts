/** A cookie as CDP's `Storage.getCookies` gives it, with what an import keeps (docs/IMPLEMENTATION.md §14 step 6). */
export type Cookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Seconds since the epoch; -1 for a session cookie. */
  expires: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
};

/** One browser's cookies over its CDP browser session; cookies stay in memory only. */
export type CookieJar = {
  /** Every cookie the browser holds, or `null` when it would not say. */
  read(): Promise<Cookie[] | null>;
  /** Sets the cookies (in batches of 500); how many were set and how many failed. */
  write(cookies: readonly Cookie[]): Promise<{ set: number; failed: number }>;
  close(): void;
};

/**
 * Connects to a browser's WebSocket for its cookies (§14): the main Chrome's, which waits for its Allow dialog, and the
 * Desk Chrome's. Adapter: packages/chrome (`Storage.getCookies` and `Storage.setCookies`). `null` when it did not connect
 * within `timeoutMs`.
 */
export interface CookieBrowser {
  connect(wsUrl: string, timeoutMs: number): Promise<CookieJar | null>;
}
