/**
 * Which CDP target a Chrome tab is, for the service worker (docs/IMPLEMENTATION.md §3, §11). Adapter: `chrome.tabs` and
 * `chrome.debugger.getTargets`, which lists targets without attaching to any.
 */
export interface TabTargets {
  /** The target id of the active tab in the window, or `null` when it has none that is a page. */
  activeTabTarget(windowId: number): Promise<string | null>;
  /** The target id of a tab, or `null` when Chrome lists no page target for it. */
  targetOfTab(tabId: number): Promise<string | null>;
}
