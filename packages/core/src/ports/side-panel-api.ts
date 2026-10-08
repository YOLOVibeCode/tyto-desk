/** The extension's side panel, as the service worker sees it (docs/IMPLEMENTATION.md §3). Adapter: `chrome.sidePanel`. */
export interface SidePanelApi {
  /** Makes the toolbar action open the panel (`setPanelBehavior({openPanelOnActionClick: true})`). */
  openOnActionClick(): Promise<void>;
  /** The windows whose panel is open now (`runtime.getContexts` for `SIDE_PANEL`). */
  openWindows(): Promise<readonly number[]>;
  /** The page Chrome opens as the panel from now on (`setOptions({path})`). */
  setPath(path: string): Promise<void>;
  /**
   * Opens (or shows) the window's panel (`sidePanel.open`). Chrome allows it only inside a user gesture, so callers make
   * it their first call, before any await; it returns nothing to wait for.
   */
  openInGesture(windowId: number): void;
  /** Closes the window's panel (`sidePanel.close`, which needs no gesture). */
  close(windowId: number): Promise<void>;
  onOpened(listener: (windowId: number) => void): void;
  onClosed(listener: (windowId: number) => void): void;
}
