import { describe, expect, it } from "vitest";
import { PanelController, type Layout } from "../src/index.ts";
import { FakeClock, FakeHostConnector, FakeLayoutView, FakePageVisibility, FakeTerminalView, SeqRandom } from "../src/testing/index.ts";

const P1 = "p_k2m9q3x7ab";
const P2 = "p_m9x1d4f6hz";
const P3 = "p_r4t6v8x0bc";
const T1 = "t_k2m9q3x7ab";
const T2 = "t_m9x1d4f6hz";

function setup(options: { cols?: number; closeOnExit?: boolean } = {}) {
  const connector = new FakeHostConnector();
  const view = new FakeTerminalView({ cols: options.cols ?? 200, rows: 40 });
  const layoutView = new FakeLayoutView();
  const panel = new PanelController({
    connector,
    view,
    layout: layoutView,
    random: new SeqRandom([]),
    clock: new FakeClock(),
    build: "0.3.0",
    windowId: 7,
    focusOnLoad: true,
    visibility: new FakePageVisibility(),
  });
  return { connector, view, layoutView, panel };
}

const tab = (id: string, focus: string, root: Layout["tabs"][number]["root"]) => ({ id, focus, zoomed: null, root });
const layoutOf = (...tabs: Layout["tabs"]): Layout => ({ version: 1, activeTab: tabs[0]?.id ?? null, ui: {}, tabs });
const hello = (live: string[], layout?: Layout, closeOnExit = false) => ({
  type: "hello",
  v: 1,
  build: "0.3.0",
  panes: live.map((id) => ({ id, alive: true })),
  notices: [],
  closeOnExit,
  ...(layout === undefined ? {} : { layout }),
});
const posted = (connector: FakeHostConnector, type: string) => connector.last().posted.filter((m) => (m as { type?: string }).type === type);
const lastPut = (connector: FakeHostConnector): Layout | undefined => (posted(connector, "layout.put").at(-1) as { layout?: Layout } | undefined)?.layout;

describe("the panel's tabs and splits (docs/IMPLEMENTATION.md §10, slice 6)", () => {
  it("the panel lays out the layout its hello carries and opens every pane in it, in every tab", () => {
    const { connector, layoutView, panel } = setup();
    panel.start();

    connector.last().deliver(hello([P1, P2, P3], layoutOf(tab(T1, P1, { split: "row", ratio: 0.5, a: { pane: P1 }, b: { pane: P2 } }), tab(T2, P3, { pane: P3 }))));

    expect(posted(connector, "open").map((m) => (m as { pane: string }).pane)).toEqual([P1, P2, P3]);
    expect(layoutView.last()).toMatchObject({ active: T1, focus: P1, root: { split: "row", a: { pane: P1 }, b: { pane: P2 } } });
    expect(layoutView.last().tabs.map((t) => t.id)).toEqual([T1, T2]);
  });

  it("split right puts a new pane beside the focused one, in the focused pane's directory, and focuses it", () => {
    const { connector, view, layoutView, panel } = setup();
    panel.start();
    connector.last().deliver(hello([P1], layoutOf(tab(T1, P1, { pane: P1 }))));

    panel.split("right");

    const added = posted(connector, "open").at(-1) as { pane: string; cwdFrom?: string };
    expect(added.cwdFrom).toBe(P1);
    expect(lastPut(connector)?.tabs[0]).toEqual(tab(T1, added.pane, { split: "row", ratio: 0.5, a: { pane: P1 }, b: { pane: added.pane } }));
    expect(view.of(added.pane).focuses).toBe(1);
    expect(layoutView.last().focus).toBe(added.pane);
  });

  it("split right in a panel too narrow for two 80-column panes splits down and says so", () => {
    const { connector, layoutView, panel } = setup({ cols: 120 });
    panel.start();
    connector.last().deliver(hello([P1], layoutOf(tab(T1, P1, { pane: P1 }))));

    panel.split("right");

    expect(lastPut(connector)?.tabs[0]?.root).toMatchObject({ split: "col" });
    expect(layoutView.notes).toEqual(["Split down: the panel is too narrow for two 80-column panes"]);
  });

  it("closing the last pane of a tab closes the tab, and closing the last tab opens a fresh pane", () => {
    const { connector, view, panel } = setup();
    panel.start();
    connector.last().deliver(hello([P1, P2], layoutOf(tab(T1, P1, { pane: P1 }), tab(T2, P2, { pane: P2 }))));

    panel.selectTab(2);
    panel.closeFocused();
    const afterFirst = lastPut(connector);
    panel.closeFocused();

    expect(afterFirst?.tabs.map((t) => t.id)).toEqual([T1]);
    expect(posted(connector, "close").map((m) => (m as { pane: string }).pane)).toEqual([P2, P1]);
    const fresh = posted(connector, "open").at(-1) as { pane: string; cwdFrom?: string };
    expect(fresh.pane).not.toBe(P1);
    expect(fresh.cwdFrom).toBeUndefined();
    expect(lastPut(connector)?.tabs.map((t) => t.root)).toEqual([{ pane: fresh.pane }]);
    expect(view.panes.filter((p) => p.id === P1).every((p) => p.disposed)).toBe(true);
  });

  it("the saved layout loses a pane only when the user closes it", () => {
    const { connector, panel } = setup();
    panel.start();

    connector.last().deliver(hello([P1], layoutOf(tab(T1, P1, { split: "col", ratio: 0.4, a: { pane: P1 }, b: { pane: P2 } }))));

    expect(posted(connector, "open").map((m) => (m as { pane: string }).pane)).toEqual([P1, P2]);
    expect(posted(connector, "layout.put")).toEqual([]);
  });

  it("a live pane missing from the layout is added back as a tab", () => {
    const { connector, panel } = setup();
    panel.start();

    connector.last().deliver(hello([P1, P2], layoutOf(tab(T1, P1, { pane: P1 }))));

    expect(lastPut(connector)?.tabs).toEqual([tab(T1, P1, { pane: P1 }), tab(T2, P2, { pane: P2 })]);
    expect(posted(connector, "open").map((m) => (m as { pane: string }).pane)).toEqual([P1, P2]);
  });

  it("a layout change in one panel reaches every other panel", () => {
    const { connector, view, layoutView, panel } = setup();
    panel.start();
    connector.last().deliver(hello([P1], layoutOf(tab(T1, P1, { pane: P1 }))));
    const opens = posted(connector, "open").length;

    // Another window split P1: the daemon broadcasts the new layout to every panel.
    connector.last().deliver({ type: "layout", layout: layoutOf(tab(T1, P2, { split: "row", ratio: 0.5, a: { pane: P1 }, b: { pane: P2 } })) });

    expect(layoutView.last().root).toEqual({ split: "row", ratio: 0.5, a: { pane: P1 }, b: { pane: P2 } });
    expect(view.of(P2).disposed).toBe(false);
    // The pane belongs to the window that made it: this panel does not take it.
    expect(posted(connector, "open")).toHaveLength(opens);
  });

  it("a pane another panel closed leaves this panel too", () => {
    const { connector, view, panel } = setup();
    panel.start();
    connector.last().deliver(hello([P1, P2], layoutOf(tab(T1, P1, { split: "row", ratio: 0.5, a: { pane: P1 }, b: { pane: P2 } }))));

    connector.last().deliver({ type: "layout", layout: layoutOf(tab(T1, P1, { pane: P1 })) });

    expect(view.panes.filter((p) => p.id === P2).every((p) => p.disposed)).toBe(true);
  });

  it("the panel takes the echo of its own layout.put as already shown", () => {
    const { connector, layoutView, panel } = setup();
    panel.start();
    connector.last().deliver(hello([P1], layoutOf(tab(T1, P1, { pane: P1 }))));
    panel.split("right");
    panel.split("down");
    const puts = posted(connector, "layout.put").map((m) => (m as { layout: Layout }).layout);
    const shown = layoutView.shown.length;

    connector.last().deliver({ type: "layout", layout: puts[0] });

    expect(layoutView.shown).toHaveLength(shown);
  });

  it("a new tab opens after the active one, in the focused pane's directory", () => {
    const { connector, layoutView, panel } = setup();
    panel.start();
    connector.last().deliver(hello([P1, P2], layoutOf(tab(T1, P1, { pane: P1 }), tab(T2, P2, { pane: P2 }))));

    panel.newTab();

    const added = posted(connector, "open").at(-1) as { pane: string; cwdFrom?: string };
    expect(added.cwdFrom).toBe(P1);
    expect(lastPut(connector)?.tabs.map((t) => t.root)).toEqual([{ pane: P1 }, { pane: added.pane }, { pane: P2 }]);
    expect(layoutView.last().focus).toBe(added.pane);
  });

  it("clicking into a pane focuses it, and the layout records the focus", () => {
    const { connector, view, panel } = setup();
    panel.start();
    connector.last().deliver(hello([P1, P2], layoutOf(tab(T1, P1, { split: "row", ratio: 0.5, a: { pane: P1 }, b: { pane: P2 } }))));

    view.of(P2).userFocuses();

    expect(lastPut(connector)?.tabs[0]?.focus).toBe(P2);
  });

  it("picking a tab in the strip shows it and focuses its pane", () => {
    const { connector, view, layoutView, panel } = setup();
    panel.start();
    connector.last().deliver(hello([P1, P2], layoutOf(tab(T1, P1, { pane: P1 }), tab(T2, P2, { pane: P2 }))));

    layoutView.userSelects(T2);

    expect(layoutView.last()).toMatchObject({ active: T2, root: { pane: P2 } });
    expect(view.of(P2).focuses).toBe(1);
    expect(lastPut(connector)?.activeTab).toBe(T2);
  });

  it("a dragged divider's ratio is saved in the layout", () => {
    const { connector, layoutView, panel } = setup();
    panel.start();
    connector.last().deliver(hello([P1, P2], layoutOf(tab(T1, P1, { split: "row", ratio: 0.5, a: { pane: P1 }, b: { pane: P2 } }))));

    layoutView.userDrags(T1, [], 0.3);

    expect(lastPut(connector)?.tabs[0]?.root).toMatchObject({ ratio: 0.3 });
  });

  it("a shell that exits with closeOnExit closes its pane as the user would, and its sibling takes the focus", () => {
    const { connector, view, panel } = setup();
    panel.start();
    connector.last().deliver(hello([P1, P2], layoutOf(tab(T1, P2, { split: "row", ratio: 0.5, a: { pane: P1 }, b: { pane: P2 } })), true));

    connector.last().deliver({ type: "exit", pane: P2, code: 0, signal: null });

    expect(posted(connector, "close").map((m) => (m as { pane: string }).pane)).toEqual([P2]);
    expect(lastPut(connector)?.tabs[0]).toEqual(tab(T1, P1, { pane: P1 }));
    expect(view.of(P1).focuses).toBeGreaterThan(0);
  });

  it("Bring it here takes back every pane another window took", () => {
    const { connector, view, panel } = setup();
    panel.start();
    connector.last().deliver(hello([P1, P2], layoutOf(tab(T1, P1, { split: "row", ratio: 0.5, a: { pane: P1 }, b: { pane: P2 } }))));
    connector.last().deliver({ type: "detached", pane: P1, reason: "taken" });
    connector.last().deliver({ type: "detached", pane: P2, reason: "taken" });
    const opens = posted(connector, "open").length;

    view.bannerAction?.run();

    expect(posted(connector, "open").slice(opens).map((m) => (m as { pane: string }).pane)).toEqual([P1, P2]);
  });

  it("zoom, cycling panes and resizing change the layout and are saved", () => {
    const { connector, panel } = setup();
    panel.start();
    connector.last().deliver(hello([P1, P2], layoutOf(tab(T1, P1, { split: "row", ratio: 0.5, a: { pane: P1 }, b: { pane: P2 } }))));

    panel.focusNext();
    const afterNext = lastPut(connector)?.tabs[0]?.focus;
    panel.zoom();
    const zoomed = lastPut(connector)?.tabs[0]?.zoomed;
    panel.resize("left");

    expect(afterNext).toBe(P2);
    expect(zoomed).toBe(P2);
    expect(lastPut(connector)?.tabs[0]?.root).toMatchObject({ ratio: 0.45 });
  });
});
