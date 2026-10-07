import type { DeskExtension } from "./desk-extension.ts";
import type { PanelOpener } from "./panel-opener.ts";

/** One CDP connection to the Desk Chrome's browser session, seen through the role ports the launch needs. */
export type BrowserSession = { extension: DeskExtension; panels: PanelOpener; close(): void };

/** Connects to the browser WebSocket `/json/version` named (docs/IMPLEMENTATION.md §6.1 step 8). Adapter: packages/chrome. */
export interface BrowserConnector {
  connect(wsUrl: string): Promise<{ ok: true; session: BrowserSession } | { ok: false }>;
}
