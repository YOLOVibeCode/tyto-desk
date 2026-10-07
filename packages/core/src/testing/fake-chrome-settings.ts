import type { ChromeSettings, SettingsPref, SettingsRead } from "../ports/chrome-settings.ts";

/**
 * Chrome's settings in memory: a pref the test did not give is missing. `ignoreWrites` makes Chrome accept a write and
 * keep the old value; `unavailable` makes the settings page unreachable. Calls are recorded, writes also in `log`.
 */
export class FakeChromeSettings implements ChromeSettings {
  readonly prefs: Map<SettingsPref, unknown>;
  readonly calls: string[] = [];
  ignoreWrites = false;
  unavailable = false;
  private readonly log: string[];

  constructor(prefs: Partial<Record<SettingsPref, unknown>> = {}, log: string[] = []) {
    this.prefs = new Map(Object.entries(prefs) as [SettingsPref, unknown][]);
    this.log = log;
  }

  async get(pref: SettingsPref): Promise<SettingsRead> {
    this.calls.push(`get ${pref}`);
    if (this.unavailable) return { ok: false, reason: "unavailable" };
    if (!this.prefs.has(pref)) return { ok: false, reason: "missing" };
    return { ok: true, value: this.prefs.get(pref) };
  }

  async set(pref: SettingsPref, value: boolean | number): Promise<boolean> {
    this.calls.push(`set ${pref} ${JSON.stringify(value)}`);
    this.log.push(`settings.set ${pref}`);
    if (this.unavailable) return false;
    if (!this.ignoreWrites) this.prefs.set(pref, value);
    return true;
  }
}
