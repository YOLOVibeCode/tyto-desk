import {
  NATIVE_HOST_NAME,
  type Clock,
  type ExtensionWindow,
  type ExtensionWindows,
  type HostChannel,
  type HostConnector,
  type Random,
  type SidePanelApi,
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

  onOpened(listener: (windowId: number) => void): void {
    chrome.sidePanel.onOpened?.addListener((info) => listener(info.windowId));
  }

  onClosed(listener: (windowId: number) => void): void {
    chrome.sidePanel.onClosed?.addListener((info) => listener(info.windowId));
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
