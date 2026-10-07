/** Whether the panel's page can be seen (docs/IMPLEMENTATION.md §7.3, §9). Adapter: the page's `visibilitychange`. */
export interface PageVisibility {
  onChange(listener: (state: "visible" | "hidden") => void): void;
}
