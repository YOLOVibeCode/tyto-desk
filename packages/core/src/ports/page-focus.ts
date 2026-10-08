/**
 * Gives the keyboard back to a page (docs/IMPLEMENTATION.md §6.4, D108): Chrome hands a side panel the keyboard the first
 * time it shows it in a window, even one Desk opened without focus. Adapter: packages/chrome (`Page.bringToFront` on
 * the page's own session; it refuses Desk's extension targets).
 */
export interface PageFocus {
  bringToFront(targetId: string): Promise<boolean>;
}
