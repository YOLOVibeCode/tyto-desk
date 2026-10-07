/**
 * Ends the Desk Chrome the way Cmd+Q would, without asking pages about unsaved changes (docs/IMPLEMENTATION.md §3,
 * §6.3). Never a signal. Adapter: packages/chrome (`Browser.close`).
 */
export interface BrowserLifecycle {
  /** Whether Chrome took the command; a connection Chrome drops while it closes counts as taken. */
  close(): Promise<boolean>;
}
