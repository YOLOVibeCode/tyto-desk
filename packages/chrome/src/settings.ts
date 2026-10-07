import { setTimeout as sleep } from "node:timers/promises";
import { SETTINGS_PREFS, type ChromeSettings, type SettingsPref, type SettingsRead } from "@desk/core";
import { CDP_COMMAND_MS, type CdpConnection } from "./cdp.ts";

/** settingsPrivate exists on chrome://settings once its WebUI has loaded. */
const READY = "typeof chrome === 'object' && chrome !== null && typeof chrome.settingsPrivate === 'object'";

const UNAVAILABLE = Symbol("unavailable");

type Evaluate = (expression: string) => Promise<unknown>;

function allowed(pref: SettingsPref): void {
  if (!SETTINGS_PREFS.includes(pref)) throw new Error(`${JSON.stringify(pref)} is not a pref Desk may change`);
}

/**
 * Chrome's settings through `chrome.settingsPrivate` on a background chrome://settings tab (docs/IMPLEMENTATION.md §3,
 * §5; mechanism verified [RC exp3]). Each call opens the tab in the background, attaches to it, waits up to `readyMs`
 * (§6.6: 5 s) for settingsPrivate, runs one call, and closes the tab. Only §5's prefs, checked again at run time.
 */
export class CdpChromeSettings implements ChromeSettings {
  private readonly cdp: CdpConnection;
  private readonly readyMs: number;
  private readonly pollMs: number;

  constructor(cdp: CdpConnection, options: { readyMs?: number; pollMs?: number } = {}) {
    this.cdp = cdp;
    this.readyMs = options.readyMs ?? 5_000;
    this.pollMs = options.pollMs ?? 100;
  }

  async get(pref: SettingsPref): Promise<SettingsRead> {
    allowed(pref);
    const answer = await this.onSettingsPage((evaluate) =>
      evaluate(
        `chrome.settingsPrivate.getPref(${JSON.stringify(pref)}).then(` +
          "(p) => (p === undefined || p === null ? { missing: true } : { value: p.value }), () => ({ missing: true }))",
      ),
    );
    if (answer === UNAVAILABLE) return { ok: false, reason: "unavailable" };
    if (typeof answer === "object" && answer !== null && "value" in answer) return { ok: true, value: answer.value };
    return { ok: false, reason: "missing" };
  }

  async set(pref: SettingsPref, value: boolean | number): Promise<boolean> {
    allowed(pref);
    if (typeof value !== "boolean" && !Number.isInteger(value)) throw new Error("a pref value is a boolean or an integer");
    const answer = await this.onSettingsPage((evaluate) => evaluate(`chrome.settingsPrivate.setPref(${JSON.stringify(pref)}, ${JSON.stringify(value)})`));
    return answer === true;
  }

  private async onSettingsPage(work: (evaluate: Evaluate) => Promise<unknown>): Promise<unknown> {
    const created = await this.cdp.send("Target.createTarget", { url: "chrome://settings/", background: true });
    if (!created.ok || typeof created.result.targetId !== "string") return UNAVAILABLE;
    const targetId = created.result.targetId;
    try {
      const attached = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
      if (!attached.ok || typeof attached.result.sessionId !== "string") return UNAVAILABLE;
      const sessionId = attached.result.sessionId;
      const evaluate: Evaluate = async (expression) => {
        const answer = await this.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, CDP_COMMAND_MS, sessionId);
        if (!answer.ok || "exceptionDetails" in answer.result) return undefined;
        const result = answer.result.result;
        return typeof result === "object" && result !== null && "value" in result ? result.value : undefined;
      };
      const deadline = Date.now() + this.readyMs;
      while ((await evaluate(READY)) !== true) {
        if (Date.now() >= deadline) return UNAVAILABLE;
        await sleep(this.pollMs);
      }
      return await work(evaluate);
    } finally {
      await this.cdp.send("Target.closeTarget", { targetId });
    }
  }
}
