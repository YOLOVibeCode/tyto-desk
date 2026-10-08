import type { FollowedBrowser, TargetWatch, TargetWatchEvent } from "@desk/core";
import { CdpConnection, openWebSocket, type CdpTransport } from "./cdp.ts";

type Known = { url: string; attached: boolean };

/** A `TargetInfo`'s id, URL and attached flag, or `null` for anything else. */
function targetInfo(params: Record<string, unknown>): ({ targetId: string } & Known) | null {
  const info = params.targetInfo;
  if (typeof info !== "object" || info === null) return null;
  const { targetId, url, attached } = info as Record<string, unknown>;
  if (typeof targetId !== "string" || typeof url !== "string") return null;
  return { targetId, url, attached: attached === true };
}

/**
 * `desk watch`'s browser WebSocket (docs/IMPLEMENTATION.md §6.4): `Target.setDiscoverTargets` on the browser session,
 * never an attach. It reports a Desk extension target that turns attached (someone else's debugger: DevTools on the
 * panel, or a CDP client on the raw port), a Desk panel that crashed, and how many Desk panels exist after each change.
 */
export class CdpTargetWatch implements TargetWatch {
  private readonly extensionId: string;
  private readonly open: (url: string) => Promise<CdpTransport | null>;

  constructor(options: { extensionId: string; open?: (url: string) => Promise<CdpTransport | null> }) {
    this.extensionId = options.extensionId;
    this.open = options.open ?? ((url) => openWebSocket(url));
  }

  async follow(wsUrl: string, onEvent: (event: TargetWatchEvent) => void): Promise<FollowedBrowser | null> {
    const transport = await this.open(wsUrl);
    if (transport === null) return null;
    const cdp = new CdpConnection(transport);
    const desk = `chrome-extension://${this.extensionId}/`;
    const panel = `${desk}panel.html`;
    const known = new Map<string, Known>();
    // Every panel target seen, kept after it is destroyed: Chrome may report a crash after the destruction.
    const panelIds = new Set<string>();
    const panels = () => [...known.values()].filter((target) => target.url.startsWith(panel)).length;
    let reported = -1;
    const report = () => {
      const open = panels();
      if (open === reported) return;
      reported = open;
      onEvent({ type: "panels", open });
    };
    cdp.onEvent((method, params) => {
      switch (method) {
        case "Target.targetCreated":
        case "Target.targetInfoChanged": {
          const info = targetInfo(params);
          if (info === null) return;
          const before = known.get(info.targetId);
          known.set(info.targetId, { url: info.url, attached: info.attached });
          if (info.url.startsWith(panel)) panelIds.add(info.targetId);
          if (info.url.startsWith(desk) && info.attached && before?.attached !== true) onEvent({ type: "desk-attached" });
          report();
          return;
        }
        case "Target.targetDestroyed": {
          if (typeof params.targetId === "string") known.delete(params.targetId);
          report();
          return;
        }
        case "Target.targetCrashed": {
          const targetId = params.targetId;
          if (typeof targetId === "string" && panelIds.has(targetId)) onEvent({ type: "panel-crashed" });
          return;
        }
        default:
          return;
      }
    });
    const closed = new Promise<void>((resolve) => cdp.onClose(resolve));
    const discovering = await cdp.send("Target.setDiscoverTargets", { discover: true });
    if (!discovering.ok) {
      cdp.close();
      return null;
    }
    report();
    return { closed, close: () => cdp.close() };
  }
}
