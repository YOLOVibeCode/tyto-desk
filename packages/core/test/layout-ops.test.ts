import { describe, expect, it } from "vitest";
import {
  addTab,
  closePane,
  cyclePane,
  focusPane,
  layoutPanes,
  reconcileLayout,
  resizeFocused,
  selectTab,
  setRatio,
  splitPane,
  toggleZoom,
  type Layout,
} from "../src/index.ts";

const P1 = "p_0000000001";
const P2 = "p_0000000002";
const P3 = "p_0000000003";
const P4 = "p_0000000004";
const T1 = "t_0000000001";
const T2 = "t_0000000002";

const one = (): Layout => ({ version: 1, activeTab: T1, ui: {}, tabs: [{ id: T1, focus: P1, zoomed: null, root: { pane: P1 } }] });

describe("the layout's operations (docs/IMPLEMENTATION.md §10)", () => {
  it("split right puts the new pane beside the focused one, at half the width, and focuses it", () => {
    const { layout, direction } = splitPane(one(), { pane: P1, added: P2, direction: "right", cols: 200 });

    expect(direction).toBe("right");
    expect(layout.tabs[0]).toEqual({ id: T1, focus: P2, zoomed: null, root: { split: "row", ratio: 0.5, a: { pane: P1 }, b: { pane: P2 } } });
  });

  it("split down puts the new pane below the focused one", () => {
    const { layout } = splitPane(one(), { pane: P1, added: P2, direction: "down", cols: 200 });

    expect(layout.tabs[0]?.root).toEqual({ split: "col", ratio: 0.5, a: { pane: P1 }, b: { pane: P2 } });
  });

  it.each([
    [160, "down"],
    [161, "right"],
  ])("split right of a pane %i columns wide splits %s: two 80-column panes and a divider need 161", (cols, direction) => {
    expect(splitPane(one(), { pane: P1, added: P2, direction: "right", cols }).direction).toBe(direction);
  });

  it("a split inside a split replaces only the focused leaf", () => {
    const first = splitPane(one(), { pane: P1, added: P2, direction: "right", cols: 200 }).layout;

    const { layout } = splitPane(first, { pane: P2, added: P3, direction: "down", cols: 200 });

    expect(layout.tabs[0]?.root).toEqual({
      split: "row",
      ratio: 0.5,
      a: { pane: P1 },
      b: { split: "col", ratio: 0.5, a: { pane: P2 }, b: { pane: P3 } },
    });
  });

  it("closing a pane gives its place to its sibling, which takes the focus", () => {
    const split = splitPane(one(), { pane: P1, added: P2, direction: "right", cols: 200 }).layout;

    const { layout, emptied } = closePane(split, P2);

    expect(emptied).toBe(false);
    expect(layout.tabs[0]).toEqual({ id: T1, focus: P1, zoomed: null, root: { pane: P1 } });
  });

  it("closing the last pane of a tab closes the tab and makes its neighbour active", () => {
    const two = addTab(one(), { tab: T2, pane: P2 });

    const { layout, emptied } = closePane(two, P2);

    expect(emptied).toBe(false);
    expect(layout.tabs.map((tab) => tab.id)).toEqual([T1]);
    expect(layout.activeTab).toBe(T1);
  });

  it("closing the last pane of the last tab leaves no tabs, and says so", () => {
    const { layout, emptied } = closePane(one(), P1);

    expect(emptied).toBe(true);
    expect(layout.tabs).toEqual([]);
    expect(layout.activeTab).toBeNull();
  });

  it("closing a zoomed pane ends the zoom", () => {
    const split = toggleZoom(splitPane(one(), { pane: P1, added: P2, direction: "right", cols: 200 }).layout);

    expect(closePane(split, P2).layout.tabs[0]?.zoomed).toBeNull();
  });

  it("a new tab goes after the active one and becomes active", () => {
    const layout = addTab(addTab(one(), { tab: T2, pane: P2 }), { tab: "t_0000000003", pane: P3 });

    expect(layout.tabs.map((tab) => tab.id)).toEqual([T1, T2, "t_0000000003"]);
    expect(layout.activeTab).toBe("t_0000000003");
  });

  it("a live pane missing from the layout is added back as a tab", () => {
    const { layout, changed } = reconcileLayout(one(), [P1, P2], () => T2);

    expect(changed).toBe(true);
    expect(layout.tabs.map((tab) => tab.root)).toEqual([{ pane: P1 }, { pane: P2 }]);
    expect(layout.activeTab).toBe(T1);
  });

  it("the saved layout loses no pane the daemon does not list: only closing removes a pane", () => {
    const split = splitPane(one(), { pane: P1, added: P2, direction: "right", cols: 200 }).layout;

    const { layout, changed } = reconcileLayout(split, [P1], () => T2);

    expect(changed).toBe(false);
    expect(layoutPanes(layout)).toEqual([P1, P2]);
  });

  it("reconciling a layout with no active tab makes the first one active", () => {
    const { layout } = reconcileLayout({ version: 1, activeTab: null, ui: {}, tabs: [] }, [P1], () => T1);

    expect(layout.activeTab).toBe(T1);
  });

  it("cycling panes follows the tab's reading order and wraps", () => {
    const three = splitPane(splitPane(one(), { pane: P1, added: P2, direction: "right", cols: 200 }).layout, { pane: P2, added: P3, direction: "down", cols: 200 }).layout;

    const next = cyclePane(three, 1);
    const previous = cyclePane(focusPane(three, P1), -1);

    expect(next.tabs[0]?.focus).toBe(P1);
    expect(previous.tabs[0]?.focus).toBe(P3);
  });

  it("focusing a pane in another tab makes that tab active", () => {
    const layout = focusPane(addTab(one(), { tab: T2, pane: P2 }), P1);

    expect(layout.activeTab).toBe(T1);
    expect(layout.tabs[0]?.focus).toBe(P1);
  });

  it.each([
    [1, T1],
    [2, T2],
    [9, T2],
  ])("tab %i selects %s, and a number past the last tab selects the last", (n, tab) => {
    expect(selectTab(addTab(one(), { tab: T2, pane: P2 }), n).activeTab).toBe(tab);
  });

  it("zoom toggles the focused pane", () => {
    const split = splitPane(one(), { pane: P1, added: P2, direction: "right", cols: 200 }).layout;

    const zoomed = toggleZoom(split);

    expect(zoomed.tabs[0]?.zoomed).toBe(P2);
    expect(toggleZoom(zoomed).tabs[0]?.zoomed).toBeNull();
  });

  it("resizing moves the nearest divider in the arrow's direction, within 0.1 and 0.9", () => {
    const split = splitPane(one(), { pane: P1, added: P2, direction: "right", cols: 200 }).layout;

    const wider = resizeFocused(split, "left");
    const clamped = Array.from({ length: 20 }, () => 0).reduce((layout) => resizeFocused(layout, "right"), split);
    const untouched = resizeFocused(split, "up");

    expect(wider.tabs[0]?.root).toMatchObject({ ratio: 0.45 });
    expect(clamped.tabs[0]?.root).toMatchObject({ ratio: 0.9 });
    expect(untouched).toEqual(split);
  });

  it("a dragged divider sets the ratio of the split at its path, within 0.1 and 0.9", () => {
    const nested = splitPane(splitPane(one(), { pane: P1, added: P2, direction: "right", cols: 200 }).layout, { pane: P2, added: P3, direction: "down", cols: 200 }).layout;

    const layout = setRatio(setRatio(nested, T1, ["b"], 0.3), T1, [], 0.97);

    expect(layout.tabs[0]?.root).toMatchObject({ ratio: 0.9, b: { ratio: 0.3 } });
  });

  it("the panes of a layout are listed tab by tab, in reading order", () => {
    const layout = addTab(splitPane(one(), { pane: P1, added: P2, direction: "right", cols: 200 }).layout, { tab: T2, pane: P4 });

    expect(layoutPanes(layout)).toEqual([P1, P2, P4]);
  });
});
