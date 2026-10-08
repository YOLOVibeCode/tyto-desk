/** Opens a link from a terminal as a new tab in the panel's window (docs/IMPLEMENTATION.md §10). Adapter: `chrome.tabs`. */
export interface TabOpener {
  open(url: string): void;
}
