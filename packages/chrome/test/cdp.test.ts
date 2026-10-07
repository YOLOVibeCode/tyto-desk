import { describe, expect, it } from "vitest";
import { CdpConnection } from "../src/index.ts";
import { FakeCdp } from "./fake-cdp.ts";

describe("the CDP connection", () => {
  it("a CDP command resolves with its result", async () => {
    const cdp = new CdpConnection(new FakeCdp().on("Target.getTargets", () => ({ targetInfos: [] })));

    expect(await cdp.send("Target.getTargets")).toEqual({ ok: true, result: { targetInfos: [] } });
  });

  it("a CDP error answer is a failed result that keeps no part of the request", async () => {
    const cdp = new CdpConnection(
      new FakeCdp().on("Extensions.loadUnpacked", () => {
        throw new Error("Method not available.");
      }),
    );

    expect(await cdp.send("Extensions.loadUnpacked", { path: "/Users/alex/.desk/extension" })).toEqual({ ok: false, reason: "error" });
  });

  it("a CDP command that gets no answer within its budget fails", async () => {
    const cdp = new CdpConnection(new FakeCdp());

    expect(await cdp.send("Browser.getVersion", {}, 20)).toEqual({ ok: false, reason: "timeout" });
  });

  it("commands fail at once after the connection closed", async () => {
    const transport = new FakeCdp();
    const cdp = new CdpConnection(transport);
    const pending = cdp.send("Browser.getVersion", {}, 5_000);

    transport.close();

    expect(await pending).toEqual({ ok: false, reason: "closed" });
    expect(await cdp.send("Browser.getVersion")).toEqual({ ok: false, reason: "closed" });
  });

  it("the connection ignores events, answers to commands it never sent, and text that is not JSON", async () => {
    const transport = new FakeCdp().on("Browser.getVersion", () => ({ product: "Chrome/155.0.8059.40" }));
    const cdp = new CdpConnection(transport);

    transport.emit(JSON.stringify({ method: "Target.targetCreated", params: {} }));
    transport.emit(JSON.stringify({ id: 999, result: {} }));
    transport.emit("not json");

    expect(await cdp.send("Browser.getVersion")).toEqual({ ok: true, result: { product: "Chrome/155.0.8059.40" } });
  });
});
