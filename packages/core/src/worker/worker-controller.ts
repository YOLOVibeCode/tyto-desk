import type { AgentTabs } from "../ports/agent-tabs.ts";
import type { Clock } from "../ports/clock.ts";
import type { ExtensionWindows } from "../ports/extension-windows.ts";
import type { HostChannel } from "../ports/host-channel.ts";
import type { HostConnector } from "../ports/host-connector.ts";
import type { SidePanelApi } from "../ports/side-panel-api.ts";
import type { TabTargets } from "../ports/tab-targets.ts";
import { PROTOCOL_MAX, PROTOCOL_MIN, parseDaemonMessage, type ExtCall } from "../protocol/messages.ts";
import { Backoff } from "../time/backoff.ts";

export type WorkerPorts = {
  connector: HostConnector;
  sidePanel: SidePanelApi;
  windows: ExtensionWindows;
  tabs: TabTargets;
  agentTabs: AgentTabs;
  clock: Clock;
  /** The extension's Desk version. */
  build: string;
};

/** A pane id, as the daemon makes them (`p_` and 10 Crockford base32 characters), or `null`. */
function paneArg(args: unknown): string | null {
  if (typeof args !== "object" || args === null || !("pane" in args)) return null;
  const value = (args as { pane: unknown }).pane;
  return typeof value === "string" && /^p_[0-9a-z]{10}$/.test(value) ? value : null;
}

function windowArg(args: unknown): number | null {
  if (typeof args !== "object" || args === null || !("window" in args)) return null;
  const value = (args as { window: unknown }).window;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * The Desk extension's service worker (docs/IMPLEMENTATION.md §9). At start it makes the toolbar action open the panel,
 * learns which windows show the panel, and opens its own native connection, which keeps it alive while Chrome runs; it
 * says hello as `sw` and reconnects with backoff from 100 ms to 5 s whenever the host goes away. It answers the
 * extension calls the daemon relays: `windows` (each normal window's focus and panel state), `focusWindow`,
 * `tabCurrent` (the active tab's target in the last-focused window) and `tabMine` (a pane's agent tab, in a group named
 * after the pane, created in the background when missing).
 */
export class WorkerController {
  private readonly ports: WorkerPorts;
  private readonly panels = new Set<number>();
  private readonly backoff = new Backoff(100, 5_000);
  private channel: HostChannel | null = null;

  constructor(ports: WorkerPorts) {
    this.ports = ports;
  }

  async start(): Promise<void> {
    this.ports.sidePanel.onOpened((id) => this.panels.add(id));
    this.ports.sidePanel.onClosed((id) => this.panels.delete(id));
    await this.ports.sidePanel.openOnActionClick();
    for (const id of await this.ports.sidePanel.openWindows()) this.panels.add(id);
    this.connect();
  }

  private connect(): void {
    const channel = this.ports.connector.open();
    this.channel = channel;
    channel.onMessage((message) => {
      if (this.channel === channel) void this.receive(channel, message);
    });
    channel.onDisconnect(() => {
      if (this.channel !== channel) return;
      this.channel = null;
      void this.ports.clock.sleep(this.backoff.next()).then(() => this.connect());
    });
    channel.post({ type: "hello", vMin: PROTOCOL_MIN, vMax: PROTOCOL_MAX, client: "sw", build: this.ports.build });
  }

  private async receive(channel: HostChannel, raw: unknown): Promise<void> {
    const message = parseDaemonMessage(raw);
    if (message === null) return;
    if (message.type === "hello") this.backoff.reset();
    if (message.type === "ext.call") {
      const answer = await this.answer(message);
      if (this.channel === channel) channel.post(answer);
    }
  }

  private async answer(call: ExtCall): Promise<Record<string, unknown>> {
    switch (call.op) {
      case "windows": {
        const windows = await this.ports.windows.normalWindows();
        const value = windows.map((entry) => ({ ...entry, panelOpen: this.panels.has(entry.id) }));
        return { type: "ext.result", id: call.id, ok: true, value };
      }
      case "focusWindow": {
        const id = windowArg(call.args);
        if (id === null) return { type: "ext.result", id: call.id, ok: false, error: "bad-args" };
        return (await this.ports.windows.focus(id))
          ? { type: "ext.result", id: call.id, ok: true }
          : { type: "ext.result", id: call.id, ok: false, error: "no-window" };
      }
      case "tabCurrent": {
        const windowId = await this.lastFocusedWindow();
        const target = windowId === null ? null : await this.ports.tabs.activeTabTarget(windowId);
        return target === null ? { type: "ext.result", id: call.id, ok: false, error: "no-tab" } : { type: "ext.result", id: call.id, ok: true, value: target };
      }
      case "tabMine": {
        const pane = paneArg(call.args);
        if (pane === null) return { type: "ext.result", id: call.id, ok: false, error: "bad-args" };
        let tab = await this.ports.agentTabs.find(pane);
        if (tab === null) {
          const windowId = await this.lastFocusedWindow();
          tab = windowId === null ? null : await this.ports.agentTabs.create(pane, windowId);
        }
        const target = tab === null ? null : await this.ports.tabs.targetOfTab(tab);
        return target === null ? { type: "ext.result", id: call.id, ok: false, error: "no-tab" } : { type: "ext.result", id: call.id, ok: true, value: target };
      }
      default: {
        const never: never = call.op;
        throw new Error(`unknown extension call ${String(never)}`);
      }
    }
  }

  /** The last-focused normal window, else the focused one, else any; `null` when Chrome has none. */
  private async lastFocusedWindow(): Promise<number | null> {
    const windows = await this.ports.windows.normalWindows();
    return (windows.find((entry) => entry.lastFocused) ?? windows.find((entry) => entry.focused) ?? windows[0])?.id ?? null;
  }
}
