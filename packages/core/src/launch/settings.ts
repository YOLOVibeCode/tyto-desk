import type { ChromeSettings } from "../ports/chrome-settings.ts";

/** What the launch says when Chrome may still run in the background after Cmd+Q (§5). */
export const BACKGROUND_MODE_WARNING =
  'Chrome\'s background mode may still be on: turn off "Continue running background apps when Google Chrome is closed" ' +
  "in Settings > System, so the Desk Chrome does not keep running with its port open after Cmd+Q";

/**
 * §6.1 step 11 and §5's settings table. On the first run, background mode goes off where this Chrome has the pref, and
 * is read back. `session.restore_on_startup` becomes 1 only with `setContinuePref`, because the pref is syncable: tabs
 * come back through `--restore-last-session` instead. Returns a warning for the launch's message, or `null`.
 */
export async function applyChromeSettings(
  settings: ChromeSettings,
  input: { firstRun: boolean; setContinuePref: boolean },
): Promise<string | null> {
  let warning: string | null = null;
  if (input.firstRun) {
    const before = await settings.get("background_mode.enabled");
    if (before.ok) {
      if (before.value !== false) await settings.set("background_mode.enabled", false);
      const after = await settings.get("background_mode.enabled");
      if (!after.ok || after.value !== false) warning = BACKGROUND_MODE_WARNING;
    } else if (before.reason === "unavailable") {
      warning = BACKGROUND_MODE_WARNING;
    }
  }
  if (input.setContinuePref) {
    const restore = await settings.get("session.restore_on_startup");
    if (restore.ok && restore.value !== 1) await settings.set("session.restore_on_startup", 1);
  }
  return warning;
}
