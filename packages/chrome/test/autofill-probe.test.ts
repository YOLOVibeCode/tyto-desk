import { describe, expect, it } from "vitest";
import { FakeClock, MemoryOperatorOutput, ScriptedPrompter } from "@desk/core/testing";
import { CdpAutofillProbe } from "../src/index.ts";
import { FakeCdp } from "./fake-cdp.ts";

const WS = "ws://127.0.0.1:9417/devtools/browser/abc";

function probe(options: { answers?: (boolean | "no-tty")[]; filled?: boolean; running?: boolean; attach?: boolean } = {}) {
  const cdp = new FakeCdp()
    .on("Target.createTarget", () => ({ targetId: "T1" }))
    .on("Target.closeTarget", () => ({ success: true }))
    .on("Target.attachToTarget", () => (options.attach === false ? {} : { sessionId: "S1" }))
    .on("Page.navigate", () => ({ frameId: "F1" }))
    .on("Input.dispatchMouseEvent", () => ({}))
    .on("Input.dispatchKeyEvent", () => ({}))
    .on("Runtime.evaluate", (params) => ({
      result: String(params.expression).includes("getBoundingClientRect") ? { type: "object", value: { x: 120, y: 80 } } : { type: "boolean", value: options.filled ?? false },
    }));
  const out = new MemoryOperatorOutput();
  const instance = new CdpAutofillProbe({
    deskBrowser: async () => (options.running === false ? null : WS),
    open: async () => cdp,
    prompter: new ScriptedPrompter(options.answers ?? [true, false]),
    out,
    clock: new FakeClock({ auto: true }),
  });
  return { cdp, out, instance };
}

describe("desk doctor --autofill-probe (docs/IMPLEMENTATION.md §15.2, M17)", () => {
  it("a password Chrome fills with no screen-lock prompt is reported as filled without the screen lock", async () => {
    expect(await probe({ filled: true, answers: [true, false] }).instance.autofill()).toBe("filled-without-screen-lock");
  });

  it("a screen-lock prompt is reported as held for the screen lock, whether or not you then allowed it", async () => {
    expect(await probe({ filled: false, answers: [true, true] }).instance.autofill()).toBe("held-for-screen-lock");
    expect(await probe({ filled: true, answers: [true, true] }).instance.autofill()).toBe("held-for-screen-lock");
  });

  it("the probe clicks the password field and picks Chrome's suggestion over CDP, on a page served from 127.0.0.1", async () => {
    const { instance, cdp } = probe();

    await instance.autofill();

    expect(cdp.sent.find((s) => s.method === "Target.createTarget")?.params).toMatchObject({ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/), background: true });
    expect(cdp.sent.filter((s) => s.method === "Input.dispatchMouseEvent").map((s) => [s.params.type, s.params.x, s.params.y, s.sessionId])).toEqual([
      ["mousePressed", 120, 80, "S1"],
      ["mouseReleased", 120, 80, "S1"],
    ]);
    expect(cdp.sent.filter((s) => s.method === "Input.dispatchKeyEvent" && s.params.type === "keyDown").map((s) => s.params.key)).toEqual(["ArrowDown", "Enter"]);
    expect(cdp.methods().at(-1)).toBe("Target.closeTarget");
  });

  it("no fill and no prompt proves nothing, so the probe is unavailable", async () => {
    expect(await probe({ filled: false, answers: [true, false] }).instance.autofill()).toBe("unavailable");
  });

  it("the probe says how to save the throwaway password and to delete it afterwards; an answer of no is not-saved", async () => {
    const saved = probe();
    const declined = probe({ answers: [false] });

    await saved.instance.autofill();

    expect(await declined.instance.autofill()).toBe("not-saved");
    expect(saved.out.lines.join("\n")).toContain("throwaway password");
    expect(saved.out.lines.at(-1)).toContain("Delete the throwaway password");
    expect(declined.out.lines.join("\n")).not.toContain("Delete");
  });

  it("without the Desk Chrome, a terminal, or a session on the tab the probe is unavailable", async () => {
    expect(await probe({ running: false }).instance.autofill()).toBe("unavailable");
    expect(await probe({ answers: ["no-tty"] }).instance.autofill()).toBe("unavailable");
    expect(await probe({ attach: false }).instance.autofill()).toBe("unavailable");
  });
});
