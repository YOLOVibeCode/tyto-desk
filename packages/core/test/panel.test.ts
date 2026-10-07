import { describe, expect, it } from "vitest";
import { PanelController } from "../src/index.ts";
import { FakeClock, FakeHostConnector, FakeTerminalView, SeqRandom } from "../src/testing/index.ts";

const PANE = "p_k2m9q3x7ab";

function setup(options: { focusOnLoad?: boolean } = {}) {
  const connector = new FakeHostConnector();
  const view = new FakeTerminalView({ cols: 100, rows: 30 });
  const clock = new FakeClock();
  const panel = new PanelController({
    connector,
    view,
    random: new SeqRandom([]),
    clock,
    build: "0.3.0",
    windowId: 7,
    focusOnLoad: options.focusOnLoad ?? true,
  });
  return { connector, view, clock, panel };
}

const hello = (panes: { id: string; alive: boolean }[] = []) => ({ type: "hello", v: 1, build: "0.3.0", panes, notices: [] });

describe("the side panel", () => {
  it("the panel says hello with its window, then opens a new pane at the terminal's size", () => {
    const { connector, view, panel } = setup();

    panel.start();
    connector.last().deliver(hello());

    expect(connector.last().posted).toEqual([
      { type: "hello", vMin: 1, vMax: 1, client: "panel", build: "0.3.0", window: 7 },
      { type: "open", id: "o1", pane: "p_0000000001", cols: 100, rows: 30 },
    ]);
    expect(view.pane().id).toBe("p_0000000001");
  });

  it("the panel re-attaches the daemon's live pane instead of starting another", () => {
    const { connector, view, panel } = setup();
    panel.start();

    connector.last().deliver(hello([{ id: PANE, alive: true }]));

    expect(connector.last().posted.at(-1)).toEqual({ type: "open", id: "o1", pane: PANE, cols: 100, rows: 30 });
    expect(view.panes.map((p) => p.id)).toEqual([PANE]);
  });

  it("the panel resets the terminal and writes the snapshot when it attaches", () => {
    const { connector, view, panel } = setup();
    panel.start();
    connector.last().deliver(hello([{ id: PANE, alive: true }]));
    view.pane().write("stale");

    connector.last().deliver({ type: "snapshot", pane: PANE, part: 0, last: true, cols: 100, rows: 30, data: "prompt % " });

    expect(view.pane().resets).toBe(1);
    expect(view.pane().screen).toBe("prompt % ");
  });

  it("typed input goes to the pane, and the pane's output to the terminal", () => {
    const { connector, view, panel } = setup();
    panel.start();
    connector.last().deliver(hello([{ id: PANE, alive: true }]));
    connector.last().deliver({ type: "snapshot", pane: PANE, part: 0, last: true, cols: 100, rows: 30, data: "" });

    view.pane().type("echo desk-ok\r");
    connector.last().deliver({ type: "out", pane: PANE, data: "desk-ok\r\n" });

    expect(connector.last().posted.at(-1)).toEqual({ type: "in", pane: PANE, data: "echo desk-ok\r" });
    expect(view.pane().screen).toBe("desk-ok\r\n");
  });

  it("the panel sends the terminal's new size when it is resized", () => {
    const { connector, view, panel } = setup();
    panel.start();
    connector.last().deliver(hello([{ id: PANE, alive: true }]));

    view.pane().resize({ cols: 132, rows: 43 });

    expect(connector.last().posted.at(-1)).toEqual({ type: "resize", pane: PANE, cols: 132, rows: 43 });
  });

  it("output for another pane never reaches this terminal", () => {
    const { connector, view, panel } = setup();
    panel.start();
    connector.last().deliver(hello([{ id: PANE, alive: true }]));

    connector.last().deliver({ type: "out", pane: "p_m9x1d4f6hz", data: "not mine" });

    expect(view.pane().screen).toBe("");
  });

  it("the panel focuses its terminal on load, unless it was opened with focus=0", () => {
    const focused = setup();
    const unfocused = setup({ focusOnLoad: false });
    for (const { connector, panel } of [focused, unfocused]) {
      panel.start();
      connector.last().deliver(hello([{ id: PANE, alive: true }]));
    }

    expect(focused.view.pane().focuses).toBe(1);
    expect(unfocused.view.pane().focuses).toBe(0);
  });

  it("when the shell exits the panel says so, and Enter starts a new one", () => {
    const { connector, view, panel } = setup();
    panel.start();
    connector.last().deliver(hello([{ id: PANE, alive: true }]));

    connector.last().deliver({ type: "exit", pane: PANE, code: 0, signal: null });
    view.pane().type("x");
    view.pane().type("\r");

    expect(view.panes[0]?.screen).toContain("[the shell exited: press Enter for a new one]");
    expect(connector.last().posted.filter((m) => (m as { type: string }).type === "in")).toEqual([]);
    expect(connector.last().posted.at(-1)).toEqual({ type: "open", id: "o2", pane: "p_0000000001", cols: 100, rows: 30 });
  });

  it("the panel shows a notice from the daemon in its banner", () => {
    const { connector, view, panel } = setup();
    panel.start();

    connector.last().deliver({ type: "notice", kind: "tmux-line-missing" });

    expect(view.bannerText).toBe("Agents can't see this Desk until the tmux line is added (desk install); then open a new pane");
  });

  it("the panel says so when another window takes its pane", () => {
    const { connector, view, panel } = setup();
    panel.start();
    connector.last().deliver(hello([{ id: PANE, alive: true }]));

    connector.last().deliver({ type: "detached", pane: PANE, reason: "taken" });

    expect(view.bannerText).toBe("Open in another window");
  });

  it("the panel reconnects with backoff from 100 ms to 2 s after the host disconnects, and attaches the same pane", async () => {
    const { connector, view, clock, panel } = setup();
    panel.start();
    connector.last().deliver(hello([{ id: PANE, alive: true }]));

    const waits: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const before = clock.sleeps.length;
      connector.last().drop();
      waits.push(clock.sleeps[before] ?? -1);
      await clock.advance(clock.sleeps[before] ?? 0);
    }
    connector.last().deliver(hello([{ id: PANE, alive: true }]));

    expect(waits).toEqual([100, 200, 400, 800, 1_600, 2_000]);
    expect(view.bannerText).toBeNull();
    expect(view.panes.map((p) => p.id)).toEqual([PANE]);
    expect(connector.last().posted.at(-1)).toMatchObject({ type: "open", pane: PANE });
  });

  it("the panel tells the user when Desk was updated and the daemon speaks an older protocol", () => {
    const { connector, view, panel } = setup();
    panel.start();

    connector.last().deliver({ type: "error", code: "E_STALE", message: "no protocol version in common" });

    expect(view.bannerText).toMatch(/^Desk was updated/);
  });

  it("the panel drops messages it cannot read", () => {
    const { connector, view, panel } = setup();
    panel.start();
    connector.last().deliver(hello([{ id: PANE, alive: true }]));

    connector.last().deliver({ type: "out", pane: PANE, data: 42 });
    connector.last().deliver({ type: "eval", code: "alert(1)" });

    expect(view.pane().screen).toBe("");
  });
});
