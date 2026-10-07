import { describe, expect, it } from "vitest";
import { CdpBrowserLifecycle, CdpChromeSettings, CdpConnection } from "../src/index.ts";
import { FakeCdp } from "./fake-cdp.ts";

/**
 * A Chrome whose chrome://settings page exposes settingsPrivate after `readyAfter` probes, with these prefs. A pref it
 * does not have resolves to undefined, as settingsPrivate.getPref does.
 */
function settingsChrome(prefs: Record<string, unknown>, options: { readyAfter?: number; setAnswer?: boolean } = {}) {
  let probes = 0;
  const transport = new FakeCdp()
    .on("Target.createTarget", () => ({ targetId: "SETTINGS" }))
    .on("Target.attachToTarget", () => ({ sessionId: "S1" }))
    .on("Target.closeTarget", () => ({ success: true }))
    .on("Runtime.evaluate", (params) => {
      const expression = String(params.expression);
      const pref = /Pref\(("[^"]*")/.exec(expression)?.[1];
      if (expression.includes("getPref(") && pref !== undefined) {
        const name = JSON.parse(pref) as string;
        return { result: { type: "object", value: name in prefs ? { value: prefs[name] } : { missing: true } } };
      }
      if (expression.includes("setPref(")) return { result: { type: "boolean", value: options.setAnswer ?? true } };
      probes += 1;
      return { result: { type: "boolean", value: probes > (options.readyAfter ?? 0) } };
    });
  return transport;
}

describe("Chrome's settings over CDP", () => {
  it("ChromeSettings reads a pref through settingsPrivate on a background chrome://settings tab, then closes the tab", async () => {
    const transport = settingsChrome({ "background_mode.enabled": true }, { readyAfter: 2 });

    const read = await new CdpChromeSettings(new CdpConnection(transport), { pollMs: 1 }).get("background_mode.enabled");

    expect(read).toEqual({ ok: true, value: true });
    expect(transport.sent[0]).toEqual({ method: "Target.createTarget", params: { url: "chrome://settings/", background: true } });
    expect(transport.sent[1]).toEqual({ method: "Target.attachToTarget", params: { targetId: "SETTINGS", flatten: true } });
    expect(transport.sent.filter((entry) => entry.method === "Runtime.evaluate").every((entry) => entry.sessionId === "S1")).toBe(true);
    expect(transport.methods().at(-1)).toBe("Target.closeTarget");
    expect(transport.sent.at(-1)?.params).toEqual({ targetId: "SETTINGS" });
  });

  it("ChromeSettings writes a pref with settingsPrivate.setPref and reports Chrome's answer", async () => {
    const accepted = settingsChrome({ "background_mode.enabled": true });
    const refused = settingsChrome({ "background_mode.enabled": true }, { setAnswer: false });

    expect(await new CdpChromeSettings(new CdpConnection(accepted), { pollMs: 1 }).set("background_mode.enabled", false)).toBe(true);
    expect(await new CdpChromeSettings(new CdpConnection(refused), { pollMs: 1 }).set("background_mode.enabled", false)).toBe(false);
    expect(accepted.sent.some((entry) => String(entry.params.expression).includes('setPref("background_mode.enabled", false)'))).toBe(true);
  });

  it("ChromeSettings reports a pref this Chrome does not have as missing", async () => {
    const transport = settingsChrome({});

    expect(await new CdpChromeSettings(new CdpConnection(transport), { pollMs: 1 }).get("background_mode.enabled")).toEqual({ ok: false, reason: "missing" });
  });

  it("ChromeSettings reports the settings page unavailable when settingsPrivate never appears, and still closes the tab", async () => {
    const transport = settingsChrome({ "background_mode.enabled": true }, { readyAfter: Number.POSITIVE_INFINITY });

    const settings = new CdpChromeSettings(new CdpConnection(transport), { readyMs: 30, pollMs: 1 });

    expect(await settings.get("background_mode.enabled")).toEqual({ ok: false, reason: "unavailable" });
    expect(await settings.set("background_mode.enabled", false)).toBe(false);
    expect(transport.methods().filter((method) => method === "Target.closeTarget")).toHaveLength(2);
  });

  it("ChromeSettings reports the settings page unavailable when Chrome refuses to open it", async () => {
    const transport = new FakeCdp().on("Target.createTarget", () => {
      throw new Error("refused");
    });

    expect(await new CdpChromeSettings(new CdpConnection(transport), { pollMs: 1 }).get("background_mode.enabled")).toEqual({ ok: false, reason: "unavailable" });
    expect(transport.methods()).toEqual(["Target.createTarget"]);
  });

  it("ChromeSettings refuses a pref outside its allowlist without touching Chrome", async () => {
    const transport = settingsChrome({});
    const settings = new CdpChromeSettings(new CdpConnection(transport), { pollMs: 1 });

    await expect(settings.set("credentials_enable_service" as "background_mode.enabled", false)).rejects.toThrow(/not a pref Desk may change/);
    expect(transport.sent).toEqual([]);
  });
});

describe("the browser's lifecycle over CDP", () => {
  it("BrowserLifecycle closes the browser with Browser.close", async () => {
    const transport = new FakeCdp().on("Browser.close", () => ({}));

    expect(await new CdpBrowserLifecycle(new CdpConnection(transport)).close()).toBe(true);
    expect(transport.sent).toEqual([{ method: "Browser.close", params: {} }]);
  });

  it("BrowserLifecycle counts a connection Chrome drops while it closes as closed", async () => {
    const transport = new FakeCdp();
    const lifecycle = new CdpBrowserLifecycle(new CdpConnection(transport));

    const closing = lifecycle.close();
    transport.close();

    expect(await closing).toBe(true);
  });

  it("BrowserLifecycle reports a Browser.close Chrome refused", async () => {
    const transport = new FakeCdp().on("Browser.close", () => {
      throw new Error("Not allowed");
    });

    expect(await new CdpBrowserLifecycle(new CdpConnection(transport)).close()).toBe(false);
  });
});

describe("the CDP connection's target sessions", () => {
  it("CdpConnection sends a command on a target session with its sessionId", async () => {
    const transport = new FakeCdp().on("Runtime.evaluate", (_params, sessionId) => ({ result: { value: sessionId } }));

    const answer = await new CdpConnection(transport).send("Runtime.evaluate", { expression: "1" }, 5_000, "S9");

    expect(answer).toEqual({ ok: true, result: { result: { value: "S9" } } });
    expect(transport.sent).toEqual([{ method: "Runtime.evaluate", params: { expression: "1" }, sessionId: "S9" }]);
  });
});
