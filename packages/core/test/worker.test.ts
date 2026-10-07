import { describe, expect, it } from "vitest";
import { WorkerController } from "../src/index.ts";
import { FakeClock, FakeExtensionWindows, FakeHostConnector, FakeSidePanelApi } from "../src/testing/index.ts";

function setup(options: { open?: number[] } = {}) {
  const connector = new FakeHostConnector();
  const sidePanel = new FakeSidePanelApi(options.open ?? []);
  const windows = new FakeExtensionWindows([
    { id: 7, focused: true, lastFocused: true },
    { id: 8, focused: false, lastFocused: false },
  ]);
  const clock = new FakeClock();
  const worker = new WorkerController({ connector, sidePanel, windows, clock, build: "0.3.0" });
  return { connector, sidePanel, windows, clock, worker };
}

/** Lets the worker's pending promises run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

const hello = { type: "hello", v: 1, build: "0.3.0", panes: [], notices: [] };

describe("the service worker", () => {
  it("the worker makes the toolbar action open the panel", async () => {
    const { sidePanel, worker } = setup();

    await worker.start();

    expect(sidePanel.openOnAction).toBe(true);
  });

  it("the worker connects to the host at start and says hello as the service worker", async () => {
    const { connector, worker } = setup();

    await worker.start();

    expect(connector.channels).toHaveLength(1);
    expect(connector.last().posted).toEqual([{ type: "hello", vMin: 1, vMax: 1, client: "sw", build: "0.3.0" }]);
  });

  it("the worker answers windows with each normal window's focus and panel state", async () => {
    const { connector, sidePanel, worker } = setup({ open: [8] });
    await worker.start();
    connector.last().deliver(hello);
    sidePanel.show(7);
    sidePanel.hide(8);

    connector.last().deliver({ type: "ext.call", id: "x1", op: "windows" });
    await settle();

    expect(connector.last().posted.at(-1)).toEqual({
      type: "ext.result",
      id: "x1",
      ok: true,
      value: [
        { id: 7, focused: true, lastFocused: true, panelOpen: true },
        { id: 8, focused: false, lastFocused: false, panelOpen: false },
      ],
    });
  });

  it("the worker focuses the window a focusWindow call names", async () => {
    const { connector, windows, worker } = setup();
    await worker.start();

    connector.last().deliver({ type: "ext.call", id: "x2", op: "focusWindow", args: { window: 8 } });
    await settle();

    expect(windows.focused).toEqual([8]);
    expect(connector.last().posted.at(-1)).toEqual({ type: "ext.result", id: "x2", ok: true });
  });

  it("the worker answers a focusWindow call without a window id with an error", async () => {
    const { connector, windows, worker } = setup();
    await worker.start();

    connector.last().deliver({ type: "ext.call", id: "x3", op: "focusWindow", args: { window: "eight" } });
    await settle();

    expect(windows.focused).toEqual([]);
    expect(connector.last().posted.at(-1)).toEqual({ type: "ext.result", id: "x3", ok: false, error: "bad-args" });
  });

  it("the worker reconnects with backoff from 100 ms to 5 s when the host disconnects", async () => {
    const { connector, clock, worker } = setup();
    await worker.start();

    const waits: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = clock.sleeps.length;
      connector.last().drop();
      await settle();
      waits.push(clock.sleeps[before] ?? -1);
      await clock.advance(clock.sleeps[before] ?? 0);
    }

    expect(waits).toEqual([100, 200, 400, 800, 1_600, 3_200, 5_000, 5_000]);
    expect(connector.channels).toHaveLength(9);
    expect(connector.last().posted).toEqual([{ type: "hello", vMin: 1, vMax: 1, client: "sw", build: "0.3.0" }]);
  });

  it("the worker's backoff starts over once the daemon answers hello", async () => {
    const { connector, clock, worker } = setup();
    await worker.start();
    connector.last().drop();
    await settle();
    await clock.advance(100);
    connector.last().drop();
    await settle();
    await clock.advance(200);

    connector.last().deliver(hello);
    const before = clock.sleeps.length;
    connector.last().drop();
    await settle();

    expect(clock.sleeps[before]).toBe(100);
  });

  it("the worker drops messages it cannot read", async () => {
    const { connector, worker } = setup();
    await worker.start();

    connector.last().deliver({ type: "ext.call", id: "x1", op: "cookies" });
    connector.last().deliver("not an object");
    await settle();

    expect(connector.last().posted).toHaveLength(1);
  });
});
