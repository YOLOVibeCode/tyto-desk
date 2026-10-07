/**
 * Opens the Desk panel from outside the extension, over CDP (docs/IMPLEMENTATION.md §3, §6.1 step 12): the toolbar
 * action on a tab target runs `sidePanel.open` with Chrome's own gesture. Adapter: packages/chrome.
 */
export interface PanelOpener {
  /** A tab target in the window with this id (the id CDP and the extension share), or `null`. */
  tabTargetInWindow(windowId: number): Promise<string | null>;
  /** Any tab target, or `null` when Chrome has no tab. */
  anyTabTarget(): Promise<string | null>;
  /** Runs the extension's toolbar action on the tab target (`Extensions.triggerAction`). */
  open(extensionId: string, tabTargetId: string): Promise<boolean>;
  /** Opens a new normal window. */
  newWindow(): Promise<boolean>;
}
