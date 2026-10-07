/** The extension's side panel, as the service worker sees it (docs/IMPLEMENTATION.md §3). Adapter: `chrome.sidePanel`. */
export interface SidePanelApi {
  /** Makes the toolbar action open the panel (`setPanelBehavior({openPanelOnActionClick: true})`). */
  openOnActionClick(): Promise<void>;
  /** The windows whose panel is open now (`runtime.getContexts` for `SIDE_PANEL`). */
  openWindows(): Promise<readonly number[]>;
  onOpened(listener: (windowId: number) => void): void;
  onClosed(listener: (windowId: number) => void): void;
}
