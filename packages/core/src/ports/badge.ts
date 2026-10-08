/** The toolbar button's badge (docs/IMPLEMENTATION.md §10: a bell while the panel is hidden). Adapter: `chrome.action`. */
export interface Badge {
  /** Shows `text` on the badge, or clears it with `null`. */
  set(text: string | null): void;
}
