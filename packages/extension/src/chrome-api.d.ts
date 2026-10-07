/**
 * The Chrome extension APIs the Desk extension uses, and nothing else (docs/IMPLEMENTATION.md §9), as Chrome 155
 * defines them. Only the adapters in this package touch them; core never does.
 */
declare namespace chrome {
  namespace runtime {
    interface Port {
      postMessage(message: unknown): void;
      disconnect(): void;
      readonly onMessage: { addListener(listener: (message: unknown) => void): void };
      readonly onDisconnect: { addListener(listener: () => void): void };
    }
    const lastError: { message?: string } | undefined;
    function getManifest(): { version: string; version_name?: string };
    function connectNative(application: string): Port;
    function getContexts(filter: { contextTypes: string[] }): Promise<{ windowId: number }[]>;
  }
  namespace sidePanel {
    function setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
    /** Chrome 141 and later. */
    const onOpened: { addListener(listener: (info: { windowId: number }) => void): void } | undefined;
    const onClosed: { addListener(listener: (info: { windowId: number }) => void): void } | undefined;
  }
  namespace windows {
    interface Window {
      id?: number;
      focused: boolean;
      type?: string;
    }
    function getAll(query: { windowTypes: string[] }): Promise<Window[]>;
    function getLastFocused(query: { windowTypes: string[] }): Promise<Window>;
    function getCurrent(): Promise<Window>;
    function update(windowId: number, info: { focused: boolean }): Promise<Window>;
  }
  namespace tabs {
    function getCurrent(): Promise<{ id?: number } | undefined>;
  }
}
