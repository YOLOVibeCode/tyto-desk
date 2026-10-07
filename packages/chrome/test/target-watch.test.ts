import { describe, expect, it } from "vitest";
import type { TargetWatchEvent } from "@desk/core";
import { CdpTargetWatch } from "../src/index.ts";
import { FakeCdp } from "./fake-cdp.ts";

const ID = "nmnljgjkacmplpfllopodplgmpjogdbf";
const PANEL = `chrome-extension://${ID}/panel.html`;
const WORKER = `chrome-extension://${ID}/sw.js`;

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

async function followed(cdp = new FakeCdp().on("Target.setDiscoverTargets", () => ({}))) {
  const events: TargetWatchEvent[] = [];
  const watch = new CdpTargetWatch({ extensionId: ID, open: async () => cdp });
  const handle = await watch.follow("ws://127.0.0.1:9417/devtools/browser/b-1", (event) => events.push(event));
  const event = (method: string, params: Record<string, unknown>) => cdp.emit(JSON.stringify({ method, params }));
  const target = (targetId: string, url: string, attached = false) => ({ targetInfo: { targetId, type: "page", url, attached } });
  return { cdp, events, handle, event, target };
}

describe("desk watch's target watch (docs/IMPLEMENTATION.md §6.4)", () => {
  it("the target watch discovers targets on the browser session and never attaches", async () => {
    const { cdp } = await followed();

    expect(cdp.methods()).toEqual(["Target.setDiscoverTargets"]);
    expect(cdp.sent[0]?.params).toEqual({ discover: true });
  });

  it("the target watch counts the Desk panels as they come and go", async () => {
    const { events, event, target } = await followed();

    event("Target.targetCreated", target("P1", PANEL));
    event("Target.targetCreated", target("T1", "https://example.test/"));
    event("Target.targetCreated", target("P2", `${PANEL}?focus=0`));
    event("Target.targetDestroyed", { targetId: "P1" });

    expect(events).toEqual([
      { type: "panels", open: 0 },
      { type: "panels", open: 1 },
      { type: "panels", open: 2 },
      { type: "panels", open: 1 },
    ]);
  });

  it("a Desk target that turns attached raises desk-attached once", async () => {
    const { events, event, target } = await followed();

    event("Target.targetCreated", target("W1", WORKER));
    event("Target.targetInfoChanged", target("W1", WORKER, true));
    event("Target.targetInfoChanged", target("W1", WORKER, true));
    event("Target.targetInfoChanged", target("T1", "https://example.test/", true));

    expect(events.filter((e) => e.type === "desk-attached")).toHaveLength(1);
  });

  it("a crashed Desk panel is reported, and no other crashed target", async () => {
    const { events, event, target } = await followed();

    event("Target.targetCreated", target("P1", PANEL));
    event("Target.targetCrashed", { targetId: "P1", status: "crashed", errorCode: 11 });
    event("Target.targetCrashed", { targetId: "T9", status: "crashed", errorCode: 11 });
    await settle();

    expect(events.filter((e) => e.type === "panel-crashed")).toEqual([{ type: "panel-crashed" }]);
  });

  it("the followed browser settles closed when Chrome's socket closes", async () => {
    const { cdp, handle } = await followed();
    let closed = false;
    void handle?.closed.then(() => {
      closed = true;
    });

    cdp.close();
    await settle();

    expect(closed).toBe(true);
  });

  it("a browser that refuses discovery is not followed", async () => {
    const cdp = new FakeCdp().on("Target.setDiscoverTargets", () => {
      throw new Error("refused");
    });

    const { handle } = await followed(cdp);

    expect(handle).toBeNull();
    expect(cdp.closed).toBe(true);
  });
});
