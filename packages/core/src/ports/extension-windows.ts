/** A normal window as the extension knows it: its id, and whether it has focus or had it last. */
export type ExtensionWindow = { id: number; focused: boolean; lastFocused: boolean };

/** Chrome's normal windows, for the service worker (docs/IMPLEMENTATION.md §3). Adapter: `chrome.windows`. */
export interface ExtensionWindows {
  normalWindows(): Promise<readonly ExtensionWindow[]>;
  focus(id: number): Promise<boolean>;
}
