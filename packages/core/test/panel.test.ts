import { describe, expect, it } from "vitest";
import { PanelController } from "../src/index.ts";
import { FakeBadge, FakeClock, FakeHostConnector, FakeLayoutView, FakePageVisibility, FakeTerminalView, SeqRandom, FakeTabOpener } from "../src/testing/index.ts";

const PANE = "p_k2m9q3x7ab";

function setup(options: { focusOnLoad?: boolean } = {}) {
  const connector = new FakeHostConnector();
  const view = new FakeTerminalView({ cols: 100, rows: 30 });
  const clock = new FakeClock();
  const visibility = new FakePageVisibility();
  const panel = new PanelController({
    connector,
    view,
    layout: new FakeLayoutView(),
    badge: new FakeBadge(),
    tabs: new FakeTabOpener(),
    random: new SeqRandom([]),
    clock,
    build: "0.3.0",
    windowId: 7,
    focusOnLoad: options.focusOnLoad ?? true,
    visibility,
  });
  return { connector, view, clock, visibility, panel };
}

const hello = (panes: { id: string; alive: boolean }[] = []) => ({ type: "hello", v: 1, build: "0.3.0", panes, notices: [] });

describe("the side panel", () => {
  it("the panel says hello with its window, then opens a new pane at the terminal's size", () => {
    const { connector, view, panel } = setup();

    panel.start();
    connector.last().deliver(hello());

    // Besides the layout.put that saves the new pane's tab (slice 6).
    expect(connector.last().posted.filter((m) => (m as { type: string }).type !== "layout.put")).toEqual([
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
    // The same pane again: the daemon starts its new shell there, so exited shells never pile up as panes.
    expect(connector.last().posted.at(-1)).toEqual({ type: "open", id: "o2", pane: PANE, cols: 100, rows: 30 });
    expect(view.panes.map((p) => p.id)).toEqual([PANE]);
  });

  it.each([
    ["E_SPAWN", "The shell could not start: press Enter to try again"],
    ["E_LIMIT", "Desk's terminal daemon has no room for another pane: press Enter to try again"],
  ])("the panel shows %s for its pane in the banner, and Enter tries again", (code, text) => {
    const { connector, view, panel } = setup();
    panel.start();
    connector.last().deliver(hello());

    connector.last().deliver({ type: "error", id: "o1", pane: "p_0000000001", code, message: "fixed text" });
    const shown = view.bannerText;
    view.pane().type("\r");

    expect(shown).toBe(text);
    expect(view.bannerText).toBeNull();
    expect(connector.last().posted.at(-1)).toEqual({ type: "open", id: "o2", pane: "p_0000000001", cols: 100, rows: 30 });
  });

  it("the panel ignores a pane error about another pane", () => {
    const { connector, view, panel } = setup();
    panel.start();
    connector.last().deliver(hello([{ id: PANE, alive: true }]));

    connector.last().deliver({ type: "error", pane: "p_m9x1d4f6hz", code: "E_SPAWN", message: "fixed text" });

    expect(view.bannerText).toBeNull();
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

    expect(view.bannerText).toBe("This terminal is open in another window");
  });

  it("the panel reconnects with backoff from 100 ms to 2 s after the host disconnects, and attaches the same pane", async () => {
    const { connector, view, clock, panel } = setup();
    panel.start();
    connector.last().deliver(hello([{ id: PANE, alive: true }]));

    const waits: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      // Each connection lived past 1 s: a host that keeps closing at once is "Host failed" instead.
      await clock.advance(1_500);
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

describe("the panel's states (docs/IMPLEMENTATION.md §9's panel-state table)", () => {
  /** Lets the panel's reconnect wait run, as long as the backoff allows. */
  async function waitOut(clock: FakeClock): Promise<void> {
    await clock.advance(2_000);
  }

  it("the panel shows Not installed and stops when Chrome finds no native host", async () => {
    const { connector, view, clock, panel } = setup();
    panel.start();

    connector.last().drop("Specified native messaging host not found.");
    await waitOut(clock);

    expect(view.bannerText).toBe("Desk isn't installed for this profile: run desk install");
    expect(connector.channels).toHaveLength(1);
  });

  it("the panel shows Host failed and stops after the host's port closes within 1 s, three times", async () => {
    const { connector, view, clock, panel } = setup();
    panel.start();

    for (let i = 0; i < 3; i += 1) {
      const before = clock.sleeps.length;
      connector.last().drop();
      await clock.advance(clock.sleeps[before] ?? 0);
    }
    await waitOut(clock);

    expect(view.bannerText).toBe("Desk couldn't start its terminal host: run desk doctor");
    expect(connector.channels).toHaveLength(3);
  });

  it("the panel shows Install damaged and stops when the host says so", async () => {
    const { connector, view, clock, panel } = setup();
    panel.start();

    connector.last().deliver({ type: "host", state: "install-damaged" });
    connector.last().drop();
    await waitOut(clock);

    expect(view.bannerText).toBe("Desk's install is damaged: run desk install");
    expect(connector.channels).toHaveLength(1);
  });

  it("the panel shows Daemon unreachable and retries with backoff", async () => {
    const { connector, view, clock, panel } = setup();
    panel.start();
    await clock.advance(1_500);

    connector.last().deliver({ type: "host", state: "no-daemon" });
    connector.last().drop();
    const banner = view.bannerText;
    await waitOut(clock);

    expect(banner).toBe("The terminal daemon isn't running: run desk doctor");
    expect(connector.channels).toHaveLength(2);
  });

  it("the panel shows Message limit and stops after three identical host drops", async () => {
    const { connector, view, clock, panel } = setup();
    panel.start();
    connector.last().deliver(hello());

    for (let i = 0; i < 3; i += 1) {
      await clock.advance(1_500);
      connector.last().deliver({ type: "host", state: "dropped" });
      connector.last().drop();
      await waitOut(clock);
    }

    expect(view.bannerText).toBe("Desk hit a message limit: run desk doctor");
    expect(connector.channels).toHaveLength(3);
  });

  it("the panel shows Updated with Restart now, which asks the daemon to restart", () => {
    const { connector, view, panel } = setup();
    panel.start();

    connector.last().deliver({ type: "error", code: "E_STALE", message: "no protocol version in common" });
    view.bannerAction?.run();

    expect(view.bannerText).toBe("Desk was updated. Restart the terminal daemon now? tmux sessions survive.");
    expect(view.bannerAction?.label).toBe("Restart now");
    expect(connector.last().posted.at(-1)).toEqual({ type: "shutdown", mode: "restart" });
  });

  it.each([
    [{ type: "notice", kind: "tmux-line-missing" }, "Agents can't see this Desk until the tmux line is added (desk install); then open a new pane"],
    [{ type: "notice", kind: "agents-paused" }, "Agents are paused: desk agents resume lets them drive this Desk again"],
  ])("the panel shows the notice %j in its banner", (message, text) => {
    const { connector, view, panel } = setup();
    panel.start();
    connector.last().deliver(hello());

    connector.last().deliver(message);

    expect(view.bannerText).toBe(text);
  });

  it.each([
    ["terminal-attached", "Something is attached to this terminal: DevTools, or a CDP client on the raw port"],
    ["agent-state-saved", "A Desk agent session saved browser state into your agent-browser files"],
  ])("the panel shows the %s alert on its own red line and leaves the banner as it is", (kind, text) => {
    const { connector, view, panel } = setup();
    panel.start();
    connector.last().deliver(hello([{ id: PANE, alive: true }]));
    connector.last().deliver({ type: "detached", pane: PANE, reason: "closed" });
    const banner = view.bannerText;

    connector.last().deliver({ type: "alert", kind });

    expect(view.alertText).toBe(text);
    expect(view.bannerText).toBe(banner);
  });
});

describe("the panel's terminal I/O (slice 2b)", () => {
  function attached() {
    const desk = setup();
    desk.panel.start();
    desk.connector.last().deliver(hello([{ id: PANE, alive: true }]));
    desk.connector.last().deliver({ type: "snapshot", pane: PANE, part: 0, last: true, cols: 100, rows: 30, data: "" });
    return desk;
  }

  it("the panel acknowledges every 5,000 characters its terminal has written", () => {
    const { connector } = attached();

    connector.last().deliver({ type: "out", pane: PANE, data: "x".repeat(3_000) });
    const before = connector.last().posted.filter((m) => (m as { type: string }).type === "ack");
    connector.last().deliver({ type: "out", pane: PANE, data: "y".repeat(3_000) });

    expect(before).toEqual([]);
    expect(connector.last().posted.filter((m) => (m as { type: string }).type === "ack")).toEqual([{ type: "ack", pane: PANE, n: 6_000 }]);
  });

  it("a paste containing ESC[201~ reaches the PTY without the escape and inside one bracketed paste", async () => {
    const { view } = attached();

    view.pane().userPastes("echo ok\u001b[201~; rm -rf ~");
    await Promise.resolve();

    expect(view.pane().pastes).toEqual(["echo ok[201~; rm -rf ~"]);
    expect(view.questions).toEqual([]);
  });

  it("a multi-line paste without bracketed paste mode asks first", async () => {
    const { view } = attached();
    view.pane().bracketed = false;
    view.answers.push(false, true);

    view.pane().userPastes("one\ntwo");
    await Promise.resolve();
    await Promise.resolve();
    view.pane().userPastes("three\nfour\nfive");
    await Promise.resolve();
    await Promise.resolve();

    expect(view.questions).toEqual(["Paste 2 lines?", "Paste 3 lines?"]);
    expect(view.pane().pastes).toEqual(["three\nfour\nfive"]);
  });

  it("the panel tells the daemon when it is hidden, and opens its pane again when it is shown", () => {
    const { connector, visibility } = attached();

    visibility.change("hidden");
    visibility.change("visible");

    expect(connector.last().posted.slice(-3)).toEqual([
      { type: "visibility", state: "hidden" },
      { type: "visibility", state: "visible" },
      { type: "open", id: "o2", pane: PANE, cols: 100, rows: 30 },
    ]);
  });

  it("exit reports the code and signal, and closeOnExit removes the pane", () => {
    const { connector, view, panel } = setup();
    panel.start();
    connector.last().deliver({ ...hello([{ id: PANE, alive: true }]), closeOnExit: true });

    connector.last().deliver({ type: "exit", pane: PANE, code: 0, signal: null });

    expect(connector.last().posted.filter((m) => (m as { type: string }).type !== "layout.put").slice(-2)).toEqual([
      { type: "close", id: "c1", pane: PANE },
      { type: "open", id: "o2", pane: "p_0000000001", cols: 100, rows: 30 },
    ]);
    expect(view.pane().id).toBe("p_0000000001");
  });

  it("a panel whose pane another window took offers to bring it back", () => {
    const { connector, view } = attached();

    connector.last().deliver({ type: "detached", pane: PANE, reason: "taken" });
    const offered = { text: view.bannerText, label: view.bannerAction?.label };
    view.bannerAction?.run();

    expect(offered).toEqual({ text: "This terminal is open in another window", label: "Bring it here" });
    expect(view.bannerText).toBeNull();
    expect(connector.last().posted.at(-1)).toEqual({ type: "open", id: "o2", pane: PANE, cols: 100, rows: 30 });
  });
});

describe("the panel's agents notice (slice 4c)", () => {
  it("desk agents resume clears the paused notice", async () => {
    const { connector, view, panel } = setup();
    panel.start();
    connector.last().deliver(hello());
    connector.last().deliver({ type: "notice", kind: "agents-paused" });
    const paused = view.bannerText;

    connector.last().deliver({ type: "notice", kind: "agents-resumed" });

    expect(paused).toBe("Agents are paused: desk agents resume lets them drive this Desk again");
    expect(view.bannerText).toBeNull();
  });

  it("agents resuming leaves any other banner alone", async () => {
    const { connector, view, panel } = setup();
    panel.start();
    connector.last().deliver(hello([{ id: PANE, alive: true }]));
    connector.last().deliver({ type: "detached", pane: PANE, reason: "closed" });

    connector.last().deliver({ type: "notice", kind: "agents-resumed" });

    expect(view.bannerText).toBe("The terminal was detached");
  });
});
