import type { BrowserConnector, BrowserSession, DeskExtension, PanelOpener } from "@desk/core";
import { assertPortAllowed } from "@desk/node";
import { CdpConnection, openWebSocket } from "./cdp.ts";
import { browserEndpointPort } from "./endpoint.ts";

const LOAD_UNPACKED_MS = 10_000;

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : [];
}

/** The Desk extension over the browser session: `Extensions.getExtensions` and `Extensions.loadUnpacked` (§6.1 step 9). */
export class CdpDeskExtension implements DeskExtension {
  private readonly cdp: CdpConnection;

  constructor(cdp: CdpConnection) {
    this.cdp = cdp;
  }

  async installedVersion(id: string): Promise<string | null> {
    const answer = await this.cdp.send("Extensions.getExtensions");
    if (!answer.ok) return null;
    const found = list(answer.result.extensions).find((extension) => extension.id === id);
    return typeof found?.version === "string" ? found.version : null;
  }

  async load(path: string): Promise<{ ok: true; id: string } | { ok: false; reason: "refused" }> {
    const answer = await this.cdp.send("Extensions.loadUnpacked", { path }, LOAD_UNPACKED_MS);
    return answer.ok && typeof answer.result.id === "string" ? { ok: true, id: answer.result.id } : { ok: false, reason: "refused" };
  }
}

/** Opens the panel from outside the extension (§6.1 step 12): tab targets, their windows, and the toolbar action. */
export class CdpPanelOpener implements PanelOpener {
  private readonly cdp: CdpConnection;

  constructor(cdp: CdpConnection) {
    this.cdp = cdp;
  }

  private async targetsOf(type: "tab" | "page"): Promise<string[]> {
    const answer = await this.cdp.send("Target.getTargets", type === "tab" ? { filter: [{ type: "tab" }] } : {});
    if (!answer.ok) return [];
    return list(answer.result.targetInfos)
      .filter((target) => target.type === type && typeof target.targetId === "string")
      .filter((target) => !String(target.url ?? "").startsWith("chrome-extension://"))
      .map((target) => String(target.targetId));
  }

  private tabTargets(): Promise<string[]> {
    return this.targetsOf("tab");
  }

  /**
   * A tab target in the window, found with `Browser.getWindowForTarget`; when Chrome places no tab target in a window,
   * a page target of that window, whose web contents the toolbar action takes as well.
   */
  async tabTargetInWindow(windowId: number): Promise<string | null> {
    for (const type of ["tab", "page"] as const) {
      for (const targetId of await this.targetsOf(type)) {
        const answer = await this.cdp.send("Browser.getWindowForTarget", { targetId });
        if (answer.ok && answer.result.windowId === windowId) return targetId;
      }
    }
    return null;
  }

  async anyTabTarget(): Promise<string | null> {
    return (await this.tabTargets())[0] ?? null;
  }

  async open(extensionId: string, tabTargetId: string): Promise<boolean> {
    return (await this.cdp.send("Extensions.triggerAction", { id: extensionId, targetId: tabTargetId })).ok;
  }

  async newWindow(): Promise<boolean> {
    return (await this.cdp.send("Target.createTarget", { url: "about:blank", newWindow: true })).ok;
  }
}

/**
 * Connects to the Desk Chrome's browser WebSocket and hands out the role adapters over that one session. It takes only
 * Chrome's browser endpoint on 127.0.0.1, and under Vitest the guard refuses a reserved port before any connection.
 */
export class CdpBrowserConnector implements BrowserConnector {
  async connect(wsUrl: string): Promise<{ ok: true; session: BrowserSession } | { ok: false }> {
    const port = browserEndpointPort(wsUrl);
    if (port === null) return { ok: false };
    assertPortAllowed(port);
    const transport = await openWebSocket(wsUrl);
    if (transport === null) return { ok: false };
    const cdp = new CdpConnection(transport);
    return { ok: true, session: { extension: new CdpDeskExtension(cdp), panels: new CdpPanelOpener(cdp), close: () => cdp.close() } };
  }
}
