import {
  NATIVE_HOST_NAME,
  type AgentTabs,
  type Badge,
  type Clock,
  type PageVisibility,
  type ExtensionWindow,
  type ExtensionWindows,
  type HostChannel,
  type HostConnector,
  type PanelFocusLink,
  type PanelQuestions,
  type Random,
  type SidePanelApi,
  type TabOpener,
  type TabTargets,
  type ToggleCommand,
} from "@desk/core";

/** `chrome.runtime.connectNative` to the Desk host (§9 `HostConnector`). */
export class ChromeHostConnector implements HostConnector {
  open(): HostChannel {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    return {
      post: (message) => port.postMessage(message),
      onMessage: (listener) => port.onMessage.addListener((message) => listener(message)),
      // Reading lastError in the listener is how Chrome learns the extension saw why the host went away.
      onDisconnect: (listener) => port.onDisconnect.addListener(() => listener(chrome.runtime.lastError?.message ?? null)),
      disconnect: () => port.disconnect(),
    };
  }
}

/**
 * `chrome.sidePanel` and the side-panel contexts Chrome reports (§9 `SidePanelApi`). It never throws: a Chrome that lacks
 * one of these leaves the worker without that fact, never without its native connection.
 */
export class ChromeSidePanel implements SidePanelApi {
  async openOnActionClick(): Promise<void> {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  }

  async openWindows(): Promise<readonly number[]> {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] }).catch(() => []);
    return contexts.map((context) => context.windowId).filter((id) => id >= 0);
  }

  async setPath(path: string): Promise<void> {
    await chrome.sidePanel.setOptions({ path }).catch(() => undefined);
  }

  openInGesture(windowId: number): void {
    void chrome.sidePanel.open({ windowId }).catch(() => undefined);
  }

  async close(windowId: number): Promise<void> {
    await chrome.sidePanel.close({ windowId }).catch(() => undefined);
  }

  onOpened(listener: (windowId: number) => void): void {
    chrome.sidePanel.onOpened?.addListener((info) => listener(info.windowId));
  }

  onClosed(listener: (windowId: number) => void): void {
    chrome.sidePanel.onClosed?.addListener((info) => listener(info.windowId));
  }
}

/** The panel's question as it loads: whether it may take the keyboard (§9). */
export const FOCUS_QUESTION = "desk-focus-on-load";
/** A panel's report to its worker: `{type, window, focused}`. */
export const PANEL_FOCUS = "desk-panel-focus";
/** The worker asks a panel to take the keyboard: `{type, window}`. */
export const FOCUS_TERMINAL = "desk-focus-terminal";

/** Whether a message came from the extension's own panel page. */
function fromPanel(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL("panel.html")) === true;
}

/** `chrome.commands`: the toggle shortcut and the window it was pressed in (§10 `ToggleCommand`). */
export class ChromeToggleCommand implements ToggleCommand {
  onToggle(listener: (windowId: number) => void): void {
    chrome.commands.onCommand.addListener((command, tab) => {
      if (command === "toggle-terminal" && typeof tab?.windowId === "number") listener(tab.windowId);
    });
  }
}

/** Panels' focus reports, and the worker's request that one take the keyboard (§10 `PanelFocusLink`). */
export class ChromePanelFocusLink implements PanelFocusLink {
  onReport(listener: (windowId: number, focused: boolean) => void): void {
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (!fromPanel(sender) || typeof message !== "object" || message === null) return undefined;
      const { type, window, focused } = message as { type?: unknown; window?: unknown; focused?: unknown };
      if (type === PANEL_FOCUS && typeof window === "number" && typeof focused === "boolean") listener(window, focused);
      return undefined;
    });
  }

  focus(windowId: number): void {
    void chrome.runtime.sendMessage({ type: FOCUS_TERMINAL, window: windowId }).catch(() => undefined);
  }
}

/** `chrome.action`'s badge (§10 `Badge`). */
export class ChromeBadge implements Badge {
  set(text: string | null): void {
    void chrome.action.setBadgeText({ text: text ?? "" }).catch(() => undefined);
  }
}

/** A link as a new tab in the panel's window (§10 `TabOpener`). */
export class ChromeTabOpener implements TabOpener {
  private readonly windowId: number;

  constructor(windowId: number) {
    this.windowId = windowId;
  }

  open(url: string): void {
    void chrome.tabs.create({ windowId: this.windowId, active: true, url }).catch(() => undefined);
  }
}

/** The worker's answer, only to the extension's own panel page (D108). */
export class ChromePanelQuestions implements PanelQuestions {
  onFocusAsked(answer: () => boolean): void {
    const panel = chrome.runtime.getURL("panel.html");
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id || sender.url?.startsWith(panel) !== true) return undefined;
      if (typeof message !== "object" || message === null || (message as { type?: unknown }).type !== FOCUS_QUESTION) return undefined;
      sendResponse({ focus: answer() });
      return undefined;
    });
  }
}

/** `chrome.windows`: the normal windows with their focus (§9 `ExtensionWindows`). */
export class ChromeWindows implements ExtensionWindows {
  async normalWindows(): Promise<readonly ExtensionWindow[]> {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const last = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
    return windows
      .filter((entry): entry is chrome.windows.Window & { id: number } => typeof entry.id === "number")
      .map((entry) => ({ id: entry.id, focused: entry.focused, lastFocused: entry.id === last?.id }));
  }

  async focus(id: number): Promise<boolean> {
    return chrome.windows.update(id, { focused: true }).then(
      () => true,
      () => false,
    );
  }
}

/**
 * Which target a tab is (§11 `TabTargets`): `chrome.tabs` for the active tab, `chrome.debugger.getTargets` for its
 * target, which lists targets and attaches to none. Never throws: an unanswered call means no tab.
 */
export class ChromeTabTargets implements TabTargets {
  async activeTabTarget(windowId: number): Promise<string | null> {
    const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
    return typeof tab?.id === "number" ? this.targetOfTab(tab.id) : null;
  }

  async targetOfTab(tabId: number): Promise<string | null> {
    const targets = await chrome.debugger.getTargets().catch(() => []);
    return targets.find((target) => target.tabId === tabId && target.type === "page")?.id ?? null;
  }
}

/**
 * Each pane's agent tab (§11 `AgentTabs`): a tab in a group titled with the pane's id, created in the background so it
 * never takes the tab you are looking at. Never throws: Chrome refusing means no tab.
 */
export class ChromeAgentTabs implements AgentTabs {
  async find(group: string): Promise<number | null> {
    const groups = (await chrome.tabGroups.query({ title: group }).catch(() => [])).filter((entry) => entry.title === group);
    for (const entry of groups) {
      const [tab] = await chrome.tabs.query({ groupId: entry.id }).catch(() => []);
      if (typeof tab?.id === "number") return tab.id;
    }
    return null;
  }

  async create(group: string, windowId: number): Promise<number | null> {
    try {
      const tab = await chrome.tabs.create({ windowId, active: false, url: "about:blank" });
      if (typeof tab.id !== "number") return null;
      const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, { title: group, collapsed: false });
      return tab.id;
    } catch {
      return null;
    }
  }
}

/** The panel page's `visibilitychange` (§7.3): a panel in a minimized or covered window is hidden. */
export class DocumentVisibility implements PageVisibility {
  onChange(listener: (state: "visible" | "hidden") => void): void {
    document.addEventListener("visibilitychange", () => listener(document.visibilityState === "hidden" ? "hidden" : "visible"));
  }
}

/** Time in an extension page or worker. */
export class BrowserClock implements Clock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** Web Crypto randomness: pane ids of 10 lowercase Crockford base32 characters. */
export class WebCryptoRandom implements Random {
  int(min: number, max: number): number {
    const values = crypto.getRandomValues(new Uint32Array(1));
    return min + ((values[0] ?? 0) % (max - min + 1));
  }

  id(prefix: string): string {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    return `${prefix}_${[...bytes].map((byte) => CROCKFORD[byte & 31] ?? "0").join("")}`;
  }
}
