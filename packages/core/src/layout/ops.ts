import type { Layout, LayoutNode, LayoutTab, SplitPath } from "./layout.ts";

/** Claude Code needs about 80 columns (§10): split right leaves two of them and a divider, or splits down. */
export const SPLIT_RIGHT_MIN_COLS = 2 * 80 + 1;
const RATIO_MIN = 0.1;
const RATIO_MAX = 0.9;
/** How far Cmd+Ctrl+arrow moves a divider. */
const RESIZE_STEP = 0.05;

export type SplitDirection = "right" | "down";
export type ArrowDirection = "left" | "right" | "up" | "down";

function clampRatio(ratio: number): number {
  return Math.round(Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio)) * 100) / 100;
}

/** The panes under `node`, in reading order (left before right, top before bottom). */
export function nodePanes(node: LayoutNode): string[] {
  return "pane" in node ? [node.pane] : [...nodePanes(node.a), ...nodePanes(node.b)];
}

/** Every pane of the layout, tab by tab, in reading order. */
export function layoutPanes(layout: Layout): string[] {
  return layout.tabs.flatMap((tab) => nodePanes(tab.root));
}

/** The tab that holds `pane`, if any. */
export function tabOf(layout: Layout, pane: string): LayoutTab | undefined {
  return layout.tabs.find((tab) => nodePanes(tab.root).includes(pane));
}

/** The active tab, or the first when none is marked active. */
export function activeTab(layout: Layout): LayoutTab | undefined {
  return layout.tabs.find((tab) => tab.id === layout.activeTab) ?? layout.tabs[0];
}

function withTab(layout: Layout, id: string, change: (tab: LayoutTab) => LayoutTab): Layout {
  return { ...layout, tabs: layout.tabs.map((tab) => (tab.id === id ? change(tab) : tab)) };
}

function replaceLeaf(node: LayoutNode, pane: string, by: LayoutNode): LayoutNode {
  if ("pane" in node) return node.pane === pane ? by : node;
  return { ...node, a: replaceLeaf(node.a, pane, by), b: replaceLeaf(node.b, pane, by) };
}

/** `node` without the leaf `pane`: its split collapses into the sibling. `null` when `node` is that leaf. */
function removeLeaf(node: LayoutNode, pane: string): LayoutNode | null {
  if ("pane" in node) return node.pane === pane ? null : node;
  const a = removeLeaf(node.a, pane);
  const b = removeLeaf(node.b, pane);
  if (a === null) return b;
  if (b === null) return a;
  return { ...node, a, b };
}

/** The sibling subtree of the leaf `pane`, whose first pane takes the focus when `pane` closes. */
function siblingOf(node: LayoutNode, pane: string): LayoutNode | null {
  if ("pane" in node) return null;
  if ("pane" in node.a && node.a.pane === pane) return node.b;
  if ("pane" in node.b && node.b.pane === pane) return node.a;
  return siblingOf(node.a, pane) ?? siblingOf(node.b, pane);
}

/**
 * Splits the leaf `pane` in two, the new pane `added` beside it (right: a `row`) or below it (down: a `col`), at half
 * its size, and focuses the new pane. Split right of a pane under 161 columns splits down instead (§10), and
 * `direction` says which one happened, so the panel can say so.
 */
export function splitPane(
  layout: Layout,
  input: { pane: string; added: string; direction: SplitDirection; cols: number },
): { layout: Layout; direction: SplitDirection } {
  const tab = tabOf(layout, input.pane);
  if (tab === undefined) return { layout, direction: input.direction };
  const direction = input.direction === "right" && input.cols < SPLIT_RIGHT_MIN_COLS ? "down" : input.direction;
  const split: LayoutNode = { split: direction === "right" ? "row" : "col", ratio: 0.5, a: { pane: input.pane }, b: { pane: input.added } };
  return {
    layout: withTab(layout, tab.id, (t) => ({ ...t, focus: input.added, zoomed: null, root: replaceLeaf(t.root, input.pane, split) })),
    direction,
  };
}

/**
 * Closes the leaf `pane`: its sibling takes its place and the focus; a tab left empty closes, and its neighbour (the
 * next one, else the previous) becomes active. `emptied` says the last tab closed, so the panel opens a fresh pane.
 */
export function closePane(layout: Layout, pane: string): { layout: Layout; emptied: boolean } {
  const tab = tabOf(layout, pane);
  if (tab === undefined) return { layout, emptied: layout.tabs.length === 0 };
  const root = removeLeaf(tab.root, pane);
  if (root === null) {
    const index = layout.tabs.indexOf(tab);
    const tabs = layout.tabs.filter((t) => t !== tab);
    const neighbour = tabs[index] ?? tabs[index - 1] ?? null;
    const activeTabId = layout.activeTab === tab.id ? (neighbour?.id ?? null) : layout.activeTab;
    return { layout: { ...layout, activeTab: activeTabId, tabs }, emptied: tabs.length === 0 };
  }
  const sibling = siblingOf(tab.root, pane);
  const focus = tab.focus === pane ? (sibling === null ? null : (nodePanes(sibling)[0] ?? null)) : tab.focus;
  return {
    layout: withTab(layout, tab.id, (t) => ({ ...t, root, focus, zoomed: t.zoomed === pane ? null : t.zoomed })),
    emptied: false,
  };
}

/** A new tab holding `pane`, after the active tab, and active. */
export function addTab(layout: Layout, input: { tab: string; pane: string }): Layout {
  const added: LayoutTab = { id: input.tab, focus: input.pane, zoomed: null, root: { pane: input.pane } };
  const current = layout.tabs.findIndex((tab) => tab.id === layout.activeTab);
  const at = current < 0 ? layout.tabs.length : current + 1;
  return { ...layout, activeTab: input.tab, tabs: [...layout.tabs.slice(0, at), added, ...layout.tabs.slice(at)] };
}

/**
 * The layout against the daemon's live panes (§10): a live pane the layout does not hold is added back as a tab of its
 * own, at the end; a pane the daemon does not list stays, since only closing removes a pane (its shell starts again
 * when it is opened). A layout without an active tab gets its first.
 */
export function reconcileLayout(layout: Layout, live: readonly string[], tabFor: (pane: string) => string): { layout: Layout; changed: boolean } {
  const held = new Set(layoutPanes(layout));
  let next = layout;
  for (const pane of live) {
    if (held.has(pane)) continue;
    const tab: LayoutTab = { id: tabFor(pane), focus: pane, zoomed: null, root: { pane } };
    next = { ...next, tabs: [...next.tabs, tab] };
  }
  if (next.activeTab === null || !next.tabs.some((tab) => tab.id === next.activeTab)) {
    const first = next.tabs[0]?.id ?? null;
    if (first !== next.activeTab) next = { ...next, activeTab: first };
  }
  return { layout: next, changed: next !== layout };
}

/** Focuses `pane`, and makes its tab active. */
export function focusPane(layout: Layout, pane: string): Layout {
  const tab = tabOf(layout, pane);
  if (tab === undefined) return layout;
  return { ...withTab(layout, tab.id, (t) => ({ ...t, focus: pane })), activeTab: tab.id };
}

/** The next (1) or previous (-1) pane of the active tab, in reading order, wrapping. */
export function cyclePane(layout: Layout, step: 1 | -1): Layout {
  const tab = activeTab(layout);
  if (tab === undefined) return layout;
  const panes = nodePanes(tab.root);
  const at = tab.focus === null ? -1 : panes.indexOf(tab.focus);
  const next = panes[(at + step + panes.length) % panes.length];
  return next === undefined ? layout : focusPane(layout, next);
}

/** Tab `n` (1-based), or the last tab when there are fewer. */
export function selectTab(layout: Layout, n: number): Layout {
  const tab = layout.tabs[Math.min(n, layout.tabs.length) - 1];
  return tab === undefined ? layout : { ...layout, activeTab: tab.id };
}

/** Zooms the active tab's focused pane, or ends its zoom. */
export function toggleZoom(layout: Layout): Layout {
  const tab = activeTab(layout);
  if (tab === undefined || tab.focus === null) return layout;
  return withTab(layout, tab.id, (t) => ({ ...t, zoomed: t.zoomed === null ? t.focus : null }));
}

/** The split at `path` set to `ratio`, within 0.1 and 0.9. */
function atPath(node: LayoutNode, path: SplitPath, change: (split: Extract<LayoutNode, { split: unknown }>) => LayoutNode): LayoutNode {
  if ("pane" in node) return node;
  const [first, ...rest] = path;
  if (first === undefined) return change(node);
  return first === "a" ? { ...node, a: atPath(node.a, rest, change) } : { ...node, b: atPath(node.b, rest, change) };
}

/** A dragged divider: the ratio of the split at `path` in tab `tab`, within 0.1 and 0.9. */
export function setRatio(layout: Layout, tab: string, path: SplitPath, ratio: number): Layout {
  return withTab(layout, tab, (t) => ({ ...t, root: atPath(t.root, path, (split) => ({ ...split, ratio: clampRatio(ratio) })) }));
}

/** The path to the nearest split above `pane` whose orientation is `split`. */
function nearestSplit(node: LayoutNode, pane: string, split: "row" | "col", path: ("a" | "b")[] = []): SplitPath | null {
  if ("pane" in node) return null;
  const side = nodePanes(node.a).includes(pane) ? "a" : nodePanes(node.b).includes(pane) ? "b" : null;
  if (side === null) return null;
  const deeper = nearestSplit(side === "a" ? node.a : node.b, pane, split, [...path, side]);
  if (deeper !== null) return deeper;
  return node.split === split ? path : null;
}

/** Cmd+Ctrl+arrow: moves the divider nearest the focused pane in the arrow's direction by 0.05, within 0.1 and 0.9. */
export function resizeFocused(layout: Layout, arrow: ArrowDirection): Layout {
  const tab = activeTab(layout);
  if (tab === undefined || tab.focus === null) return layout;
  const path = nearestSplit(tab.root, tab.focus, arrow === "left" || arrow === "right" ? "row" : "col");
  if (path === null) return layout;
  const delta = arrow === "right" || arrow === "down" ? RESIZE_STEP : -RESIZE_STEP;
  return withTab(layout, tab.id, (t) => ({ ...t, root: atPath(t.root, path, (split) => ({ ...split, ratio: clampRatio(split.ratio + delta) })) }));
}
