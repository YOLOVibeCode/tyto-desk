import type { DaemonClient, DaemonRequest, DeskWindow, ExtensionBridge } from "@desk/core";

function isDeskWindow(value: unknown): value is DeskWindow {
  if (typeof value !== "object" || value === null) return false;
  const { id, focused, lastFocused, panelOpen } = value as Record<string, unknown>;
  return typeof id === "number" && Number.isInteger(id) && typeof focused === "boolean" && typeof lastFocused === "boolean" && typeof panelOpen === "boolean";
}

/**
 * Extension facts through the daemon's `ext.call` relay (docs/IMPLEMENTATION.md §3 `ExtensionBridge`): the service worker
 * answers. `null`, or `false`, when no worker is connected or its answer is not what was asked for.
 */
export class DaemonExtensionBridge implements ExtensionBridge {
  private readonly daemon: DaemonClient;

  constructor(daemon: DaemonClient) {
    this.daemon = daemon;
  }

  private async call(request: DaemonRequest): Promise<{ ok: boolean; value: unknown } | null> {
    const opened = await this.daemon.open("cli");
    if (!opened.ok) return null;
    try {
      const reply = await opened.session.request(request);
      return reply?.type === "ext.result" ? { ok: reply.ok, value: reply.value } : null;
    } finally {
      opened.session.close();
    }
  }

  async windows(): Promise<readonly DeskWindow[] | null> {
    const answer = await this.call({ type: "ext.call", op: "windows" });
    if (answer === null || !answer.ok || !Array.isArray(answer.value) || !answer.value.every(isDeskWindow)) return null;
    return answer.value;
  }

  async focusWindow(id: number): Promise<boolean> {
    return (await this.call({ type: "ext.call", op: "focusWindow", args: { window: id } }))?.ok === true;
  }
}
