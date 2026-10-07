/** Chrome's DevTools HTTP endpoint on the Desk port (docs/IMPLEMENTATION.md §3). Adapter: packages/chrome. */
export interface DevToolsHttp {
  /** `GET /json/version`: the browser's product and its WebSocket URL, or `null` when nothing answers. */
  version(port: number): Promise<{ browser: string; wsUrl: string } | null>;
}
