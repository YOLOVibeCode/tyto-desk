/**
 * Between the worker and its panels (docs/IMPLEMENTATION.md §10's toggle): each panel reports when it gains or loses the
 * keyboard, and the worker can ask a shown panel to take it. Adapter: packages/extension (`chrome.runtime` messages
 * from and to the extension's own panel page only).
 */
export interface PanelFocusLink {
  onReport(listener: (windowId: number, focused: boolean) => void): void;
  focus(windowId: number): void;
}
