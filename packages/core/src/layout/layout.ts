import { jsonStringBytes } from "../protocol/split.ts";

/** A pane in a tab's split tree, or a split of two subtrees (§10, `layout.json` in §4.2). */
export type LayoutNode = { pane: string } | { split: "row" | "col"; ratio: number; a: LayoutNode; b: LayoutNode };
export type LayoutTab = { id: string; focus: string | null; zoomed: string | null; root: LayoutNode };
/** `layout.json`: the terminal tabs, their splits, and the ui settings (font size, theme, welcome). */
export type Layout = { version: 1; activeTab: string | null; ui: Record<string, unknown>; tabs: LayoutTab[] };

/** §7.2's limits: a layout is at most 64 KiB encoded, 16 splits deep, and 32 tabs. */
export const LAYOUT_BYTES_MAX = 64 * 1024;
export const LAYOUT_DEPTH_MAX = 16;
export const TABS_MAX = 32;

const PANE_ID = /^p_[0-9abcdefghjkmnpqrstvwxyz]{10}$/;
const TAB_ID = /^t_[0-9abcdefghjkmnpqrstvwxyz]{10}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The node, checked against the panes the daemon knows, or `null`; `depth` counts the splits above it. */
function node(value: unknown, known: ReadonlySet<string>, depth: number): LayoutNode | null {
  if (!isRecord(value)) return null;
  if ("pane" in value) {
    return Object.keys(value).length === 1 && typeof value.pane === "string" && known.has(value.pane) ? { pane: value.pane } : null;
  }
  const { split, ratio, a, b } = value;
  if (depth >= LAYOUT_DEPTH_MAX || Object.keys(value).length !== 4) return null;
  if ((split !== "row" && split !== "col") || typeof ratio !== "number" || !(ratio >= 0.1 && ratio <= 0.9)) return null;
  const left = node(a, known, depth + 1);
  const right = node(b, known, depth + 1);
  return left === null || right === null ? null : { split, ratio, a: left, b: right };
}

/**
 * A layout a panel sent (`layout.put`), checked against §7.2's limits and the panes the daemon has: `null` when it is
 * over 64 KiB, deeper than 16 splits, has more than 32 tabs, names a pane the daemon does not know, or is not a layout.
 */
export function checkLayout(value: unknown, knownPanes: Iterable<string>): Layout | null {
  if (!isRecord(value) || jsonStringBytes(JSON.stringify(value)) > LAYOUT_BYTES_MAX) return null;
  const known = new Set(knownPanes);
  const { version, activeTab, ui, tabs } = value;
  if (version !== 1 || !isRecord(ui) || !Array.isArray(tabs) || tabs.length > TABS_MAX) return null;
  if (activeTab !== null && (typeof activeTab !== "string" || !TAB_ID.test(activeTab))) return null;
  const checked: LayoutTab[] = [];
  for (const tab of tabs) {
    if (!isRecord(tab) || typeof tab.id !== "string" || !TAB_ID.test(tab.id)) return null;
    const pane = (field: unknown) => field === null || (typeof field === "string" && PANE_ID.test(field) && known.has(field));
    if (!pane(tab.focus) || !pane(tab.zoomed)) return null;
    const root = node(tab.root, known, 0);
    if (root === null) return null;
    checked.push({ id: tab.id, focus: tab.focus as string | null, zoomed: tab.zoomed as string | null, root });
  }
  return { version: 1, activeTab: activeTab as string | null, ui, tabs: checked };
}

/** The layout when none is saved, or the saved one was moved aside: each live pane in a tab of its own. */
export function defaultLayout(livePanes: readonly string[]): Layout {
  const tabs = livePanes.map((pane) => ({ id: `t_${pane.slice(2)}`, focus: pane, zoomed: null, root: { pane } }));
  return { version: 1, activeTab: tabs[0]?.id ?? null, ui: {}, tabs };
}

/** The layout versions this build reads. */
export const LAYOUT_VERSION = 1;

/**
 * `layout.json` as read at load (§4.3): `layout` when it is a layout this build can read, else `null` with `recovered`
 * true, so the caller moves the file aside: it does not parse, has a key this build does not know, or a newer version.
 * The panes it names are checked against themselves; the daemon checks them against its own at `layout.put`.
 */
export function parseStoredLayout(text: string): { layout: Layout | null; recovered: boolean } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { layout: null, recovered: true };
  }
  if (!isRecord(value) || Object.keys(value).some((key) => !["version", "activeTab", "ui", "tabs"].includes(key))) return { layout: null, recovered: true };
  const named = JSON.stringify(value).match(/p_[0-9abcdefghjkmnpqrstvwxyz]{10}/g) ?? [];
  const layout = checkLayout(value, named);
  return layout === null ? { layout: null, recovered: true } : { layout, recovered: false };
}
