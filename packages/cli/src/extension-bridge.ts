import type { DaemonClient, DaemonRequest, DeskWindow, ExtensionBridge } from "@desk/core";

function isDeskWindow(value: unknown): value is DeskWindow {
  if (typeof value !== "object" || value === null) return false;
  const { id, focused, lastFocused, panelOpen } = value as Record<string, unknown>;
  return typeof id === "number" && Number.isInteger(id) && typeof focused === "boolean" && typeof lastFocused === "boolean" && typeof panelOpen === "boolean";
}

/** A CDP target id the worker answered with: a short word of letters, digits and dashes; anything else is no answer. */
function targetId(answer: { ok: boolean; value: unknown } | null): string | null {
  return answer?.ok === true && typeof answer.value === "string" && /^[A-Za-z0-9-]{1,64}$/.test(answer.value) ? answer.value : null;
}

/**
 * Extension facts through the daemon's `ext.call` relay (docs/IMPLEMENTATION.md §3 `ExtensionBridge`): the service worker
 * answers. `null`, or `false`, when no worker is connected or its answer is not what was asked for.
 */
export class DaemonExtensionBridge implements ExtensionBridge {
  private readonly daemon: DaemonClient;
  private readonly kind: "cli" | "watch";

  /** `kind` is the client kind the daemon sees: `desk` commands are `cli`, `desk watch` is `watch`. */
  constructor(daemon: DaemonClient, kind: "cli" | "watch" = "cli") {
    this.daemon = daemon;
    this.kind = kind;
  }

  private async call(request: DaemonRequest): Promise<{ ok: boolean; value: unknown } | null> {
    const opened = await this.daemon.open(this.kind);
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

  async tabCurrent(): Promise<string | null> {
    return targetId(await this.call({ type: "ext.call", op: "tabCurrent" }));
  }

  async tabMine(pane: string): Promise<string | null> {
    return targetId(await this.call({ type: "ext.call", op: "tabMine", args: { pane } }));
  }
}
