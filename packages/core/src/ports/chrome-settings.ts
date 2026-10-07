/** The prefs Desk may read or write through settingsPrivate (docs/IMPLEMENTATION.md §5); nothing else. */
export type SettingsPref = "background_mode.enabled" | "session.restore_on_startup";

/** The allowlist, for adapters that check a pref at run time too. */
export const SETTINGS_PREFS: readonly SettingsPref[] = ["background_mode.enabled", "session.restore_on_startup"];

/**
 * - `missing`: this Chrome has no such pref (`background_mode.enabled` exists only where Chrome has background mode).
 * - `unavailable`: Chrome's settings page did not open, or settingsPrivate did not appear on it in time.
 */
export type SettingsRead = { ok: true; value: unknown } | { ok: false; reason: "missing" | "unavailable" };

/**
 * Chrome's own settings, as chrome://settings changes them (docs/IMPLEMENTATION.md §3, §5). Adapter: packages/chrome,
 * through `chrome.settingsPrivate` on a background chrome://settings tab that it closes again.
 */
export interface ChromeSettings {
  get(pref: SettingsPref): Promise<SettingsRead>;
  /** Whether Chrome accepted the value; read it back to know whether Chrome kept it. */
  set(pref: SettingsPref, value: boolean | number): Promise<boolean>;
}
