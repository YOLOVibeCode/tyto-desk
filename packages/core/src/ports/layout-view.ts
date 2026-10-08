import type { LayoutNode, SplitPath } from "../layout/layout.ts";

/** A tab in the strip: its title (text, never markup) and whether something in it rang (§10). */
export type TabLabel = { id: string; title: string; marked: boolean };

/** What the panel shows: the tab strip, and the active tab's split tree with its panes placed by id. */
export type LayoutShown = {
  tabs: readonly TabLabel[];
  active: string | null;
  root: LayoutNode | null;
  /** A zoomed pane fills the tab. */
  zoomed: string | null;
  focus: string | null;
};

/**
 * The panel's tabs and splits (docs/IMPLEMENTATION.md §10). Adapter: packages/extension (the DOM around xterm). The
 * panes themselves are `TerminalView`'s; this places them.
 */
export interface LayoutView {
  show(shown: LayoutShown): void;
  /** A short line that says what just happened ("Split down: …"), gone after a few seconds. */
  note(text: string): void;
  /** The user picked a tab in the strip. */
  onSelectTab(listener: (tab: string) => void): void;
  /** The user dragged the divider of the split at `path` in tab `tab` to `ratio`. */
  onDrag(listener: (tab: string, path: SplitPath, ratio: number) => void): void;
}
