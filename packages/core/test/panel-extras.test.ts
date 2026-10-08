import { describe, expect, it } from "vitest";
import { PanelController, type Layout } from "../src/index.ts";
import { FakeBadge, FakeClock, FakeHostConnector, FakeLayoutView, FakePageVisibility, FakeTabOpener, FakeTerminalView, SeqRandom } from "../src/testing/index.ts";

const P1 = "p_k2m9q3x7ab";
const P2 = "p_m9x1d4f6hz";
const T1 = "t_k2m9q3x7ab";
const T2 = "t_m9x1d4f6hz";

function attached() {
  const connector = new FakeHostConnector();
  const view = new FakeTerminalView({ cols: 200, rows: 40 });
  const layoutView = new FakeLayoutView();
  const visibility = new FakePageVisibility();
  const badge = new FakeBadge();
  const tabs = new FakeTabOpener();
  const panel = new PanelController({
    connector,
    view,
    layout: layoutView,
    badge,
    tabs,
    random: new SeqRandom([]),
    clock: new FakeClock(),
    build: "0.3.0",
    windowId: 7,
    focusOnLoad: true,
    visibility,
  });
  panel.start();
  const layout: Layout = {
    version: 1,
    activeTab: T1,
    ui: {},
    tabs: [
      { id: T1, focus: P1, zoomed: null, root: { pane: P1 } },
      { id: T2, focus: P2, zoomed: null, root: { pane: P2 } },
    ],
  };
  connector.last().deliver({ type: "hello", v: 1, build: "0.3.0", panes: [{ id: P1, alive: true }, { id: P2, alive: true }], notices: [], layout });
  return { connector, view, layoutView, visibility, badge, tabs, panel };
}

const label = (layoutView: FakeLayoutView, tab: string) => layoutView.last().tabs.find((t) => t.id === tab);

describe("titles, bells and links in the panel (docs/IMPLEMENTATION.md §10, slice 6c)", () => {
  it("a title the program sets names its tab, as text, cut at 200 characters", () => {
    const { view, layoutView } = attached();

    view.of(P2).titled(`<img src=x onerror=alert(1)>${"x".repeat(400)}`);

    expect(label(layoutView, T2)?.title).toHaveLength(200);
    expect(label(layoutView, T2)?.title.startsWith("<img src=x onerror=alert(1)>")).toBe(true);
    expect(label(layoutView, T1)?.title).toBe("Terminal 1");
  });

  it("a tab without a title is numbered, and an emptied title gives the number back", () => {
    const { view, layoutView } = attached();

    view.of(P1).titled("vim notes.md");
    const titled = label(layoutView, T1)?.title;
    view.of(P1).titled(" ");

    expect(titled).toBe("vim notes.md");
    expect(label(layoutView, T1)?.title).toBe("Terminal 1");
  });

  it("a bell in a tab that is not shown marks it, and showing the tab clears the mark", () => {
    const { view, layoutView, panel } = attached();

    view.of(P2).rings();
    const marked = label(layoutView, T2)?.marked;
    panel.selectTab(2);

    expect(marked).toBe(true);
    expect(label(layoutView, T2)?.marked).toBe(false);
  });

  it("a bell in the shown tab of a visible panel marks nothing", () => {
    const { view, layoutView, badge } = attached();

    view.of(P1).rings();

    expect(label(layoutView, T1)?.marked).toBe(false);
    expect(badge.changes).toEqual([]);
  });

  it("a bell while the panel is hidden sets the toolbar badge, and showing the panel clears it", () => {
    const { view, visibility, badge } = attached();
    visibility.change("hidden");

    view.of(P1).rings();
    const shown = badge.text;
    visibility.change("visible");

    expect(shown).toBe("•");
    expect(badge.text).toBeNull();
  });

  it("only http and https links open, on Cmd+click, as a new Desk tab", () => {
    const { view, tabs } = attached();

    view.of(P1).clicks("https://example.test/docs", true);
    view.of(P1).clicks("https://example.test/plain-click", false);
    view.of(P1).clicks("javascript:alert(1)", true);
    view.of(P1).clicks("file:///etc/passwd", true);

    expect(tabs.opened).toEqual(["https://example.test/docs"]);
  });
});
