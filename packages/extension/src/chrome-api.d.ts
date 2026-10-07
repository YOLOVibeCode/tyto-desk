/**
 * The Chrome extension APIs the Desk extension uses, and nothing else (docs/IMPLEMENTATION.md §9), as Chrome 155
 * defines them. Only the adapters in this package touch them; core never does.
 */
declare namespace chrome {
  export namespace runtime {
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
    const id: string;
    function getURL(path: string): string;
    function sendMessage(message: unknown): Promise<unknown>;
    interface MessageSender {
      id?: string;
      url?: string;
    }
    const onMessage: {
      addListener(listener: (message: unknown, sender: MessageSender, sendResponse: (response: unknown) => void) => boolean | undefined): void;
    };
  }
  export namespace sidePanel {
    function setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
    function setOptions(options: { path?: string; enabled?: boolean }): Promise<void>;
    /** Chrome 141 and later. */
    function close(options: { windowId: number }): Promise<void>;
    /** Chrome 141 and later. */
    const onOpened: { addListener(listener: (info: { windowId: number }) => void): void } | undefined;
    const onClosed: { addListener(listener: (info: { windowId: number }) => void): void } | undefined;
  }
  export namespace windows {
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
  export namespace tabs {
    interface Tab {
      id?: number;
      windowId: number;
      active: boolean;
      groupId: number;
    }
    function getCurrent(): Promise<{ id?: number } | undefined>;
    function query(query: { active?: boolean; windowId?: number; groupId?: number }): Promise<Tab[]>;
    function create(properties: { windowId: number; active: boolean; url: string }): Promise<Tab>;
    function group(options: { tabIds: number[]; createProperties: { windowId: number } }): Promise<number>;
  }
  export namespace tabGroups {
    interface TabGroup {
      id: number;
      title?: string;
      windowId: number;
    }
    function query(query: { title?: string }): Promise<TabGroup[]>;
    function update(groupId: number, properties: { title: string; collapsed: boolean }): Promise<TabGroup | undefined>;
  }
  /** `chrome.debugger`, declared as @types/chrome does, since `debugger` is a reserved word. */
  export namespace _debugger {
    /** Lists targets; Desk never calls `attach` (§9). */
    function getTargets(): Promise<{ type: string; id: string; tabId?: number; url: string; attached: boolean }[]>;
  }
  export { _debugger as debugger };
}
