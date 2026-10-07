/** A normal Desk window as the service worker reports it (§9): focus, and whether it shows the panel. */
export type DeskWindow = { id: number; focused: boolean; lastFocused: boolean; panelOpen: boolean };

/**
 * Extension facts the CLI asks the service worker for, through the daemon's `ext.call` relay (docs/IMPLEMENTATION.md
 * §3, §9). Adapter: packages/cli. `null` means the extension did not answer.
 */
export interface ExtensionBridge {
  windows(): Promise<readonly DeskWindow[] | null>;
  focusWindow(id: number): Promise<boolean>;
}
