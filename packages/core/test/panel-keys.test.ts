import { describe, expect, it } from "vitest";
import { PanelController, type Layout, type PanelTerminal } from "../src/index.ts";
import { FakeClock, FakeHostConnector, FakeLayoutView, FakePageVisibility, FakeTerminalView, SeqRandom } from "../src/testing/index.ts";

const P1 = "p_k2m9q3x7ab";
const P2 = "p_m9x1d4f6hz";
const T1 = "t_k2m9q3x7ab";
const ESC = "\u001b";

const terminal: PanelTerminal = { fontFamily: "Menlo", fontSize: 13, scrollback: 5000, macOptionIsMeta: false, osc52Write: false, keymap: {} };

function setup() {
  const connector = new FakeHostConnector();
  const view = new FakeTerminalView({ cols: 200, rows: 40 });
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

const one = (ui: Record<string, unknown> = {}): Layout => ({ version: 1, activeTab: T1, ui, tabs: [{ id: T1, focus: P1, zoomed: null, root: { pane: P1 } }] });
const hello = (layout: Layout, settings: PanelTerminal = terminal) => ({ type: "hello", v: 1, build: "0.3.0", panes: [{ id: P1, alive: true }], notices: [], layout, terminal: settings });
const posted = (connector: FakeHostConnector, type: string) => connector.last().posted.filter((m) => (m as { type?: string }).type === type);
const lastPut = (connector: FakeHostConnector): Layout | undefined => (posted(connector, "layout.put").at(-1) as { layout?: Layout } | undefined)?.layout;

/** A panel attached to P1, its snapshot in. */
function attached(layout: Layout = one(), settings: PanelTerminal = terminal) {
  const desk = setup();
  desk.panel.start();
  desk.connector.last().deliver(hello(layout, settings));
  desk.connector.last().deliver({ type: "snapshot", pane: P1, part: 0, last: true, cols: 200, rows: 40, data: "" });
  return desk;
}

describe("the panel's keys (docs/IMPLEMENTATION.md §10, slice 6b)", () => {
  it("a bound key runs its action and the terminal never sees it: Cmd+D splits right", () => {
    const { connector, view } = attached();

    const taken = view.of(P1).presses({ code: "KeyD", meta: true });

    expect(taken).toBe(true);
    expect(lastPut(connector)?.tabs[0]?.root).toMatchObject({ split: "row" });
  });

  it("Option+Left sends ESC b to the pane", () => {
    const { connector, view } = attached();

    view.of(P1).presses({ code: "ArrowLeft", alt: true });

    expect(posted(connector, "in").at(-1)).toEqual({ type: "in", pane: P1, data: `${ESC}b` });
  });

  it("a key the keymap does not bind goes to the terminal", () => {
    const { view } = attached();

    expect(view.of(P1).presses({ code: "KeyC", meta: true })).toBe(false);
    expect(view.of(P1).presses({ code: "KeyA" })).toBe(false);
  });

  it("key bindings are skipped while the user is composing text", () => {
    const { connector, view } = attached();

    expect(view.of(P1).presses({ code: "KeyD", meta: true, composing: true })).toBe(false);
    expect(posted(connector, "layout.put")).toEqual([]);
  });

  it("a binding from config.json replaces the default, and a refused one is named in a note", () => {
    const { connector, view, layoutView } = attached(one(), { ...terminal, keymap: { "split-right": "Cmd+Shift+E", "new-tab": "Cmd+T" } });

    view.of(P1).presses({ code: "KeyE", meta: true, shift: true });

    expect(lastPut(connector)?.tabs[0]?.root).toMatchObject({ split: "row" });
    expect(layoutView.notes).toEqual(["terminal.keymap: new-tab: Cmd+T belongs to Chrome"]);
  });

  it("the hello's terminal settings set every terminal's font and scrollback, the saved font size first", () => {
    const { view } = attached(one({ fontSize: 16 }));

    expect(view.settings.at(-1)).toEqual({ fontFamily: "Menlo", fontSize: 16, scrollback: 5000, macOptionIsMeta: false });
  });

  it("font size changes are saved in layout.json", () => {
    const { connector, view } = attached();

    view.of(P1).presses({ code: "Equal", meta: true });
    view.of(P1).presses({ code: "Equal", meta: true });
    const larger = lastPut(connector)?.ui;
    view.of(P1).presses({ code: "Minus", meta: true });
    const smaller = lastPut(connector)?.ui;
    view.of(P1).presses({ code: "Digit0", meta: true });

    expect(larger).toEqual({ fontSize: 15 });
    expect(smaller).toEqual({ fontSize: 14 });
    expect(lastPut(connector)?.ui).toEqual({});
    expect(view.settings.map((s) => s.fontSize)).toEqual([13, 14, 15, 14, 13]);
  });

  it("a font size another panel saved is applied here", () => {
    const { connector, view } = attached();

    connector.last().deliver({ type: "layout", layout: one({ fontSize: 18 }) });

    expect(view.settings.at(-1)?.fontSize).toBe(18);
  });

  it("Cmd+F opens the find bar on the focused pane, and Cmd+G and Cmd+Shift+G find the next and previous match", () => {
    const { view } = attached();

    view.of(P1).presses({ code: "KeyF", meta: true });
    view.of(P1).presses({ code: "KeyG", meta: true });
    view.of(P1).presses({ code: "KeyG", meta: true, shift: true });

    expect(view.of(P1).finds).toEqual(["open", "next", "previous"]);
  });

  it("Cmd+K clears the focused pane's scrollback", () => {
    const { view } = attached();

    view.of(P1).presses({ code: "KeyK", meta: true });

    expect(view.of(P1).clears).toBe(1);
  });

  it("the context menu's Split down splits the pane it was opened on", () => {
    const { connector, view } = attached({ version: 1, activeTab: T1, ui: {}, tabs: [{ id: T1, focus: P1, zoomed: null, root: { split: "row", ratio: 0.5, a: { pane: P1 }, b: { pane: P2 } } }] });

    view.of(P2).picks("split-down");

    expect(lastPut(connector)?.tabs[0]?.root).toMatchObject({ b: { split: "col", a: { pane: P2 } } });
  });

  it("the context menu's Clear clears that pane", () => {
    const { view } = attached();

    view.of(P1).picks("clear");

    expect(view.of(P1).clears).toBe(1);
  });

  it("Cmd+2 selects the second tab and Cmd+Opt+T opens one", () => {
    const { connector, view, layoutView } = attached();

    view.of(P1).presses({ code: "KeyT", meta: true, alt: true });
    const tabs = lastPut(connector)?.tabs.length;
    view.of(P1).presses({ code: "Digit1", meta: true });

    expect(tabs).toBe(2);
    expect(layoutView.last().active).toBe(T1);
  });
});
