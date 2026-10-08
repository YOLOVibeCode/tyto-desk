import type { ConfigStore } from "../ports/config-store.ts";
import { chromeAcceptsShortcut } from "./schema.ts";

/**
 * `desk config toggle-key <key>` (docs/IMPLEMENTATION.md §10): saves a shortcut Chrome accepts as `panel.toggleKey`.
 * The next `desk` renders it into the extension's manifest as the toggle's suggested key and loads the extension again.
 * Exit codes: 0 saved · 65 Chrome would refuse the key · 69 no config yet.
 */
export async function setToggleKey(ports: { config: ConfigStore }, key: string): Promise<{ code: 0 | 65 | 69; message: string }> {
  const trimmed = key.trim();
  if (!chromeAcceptsShortcut(trimmed)) {
    return { code: 65, message: `Chrome would refuse ${JSON.stringify(key)} as a shortcut: use Command, Ctrl or Alt with one key, as in Command+Shift+Period` };
  }
  const config = await ports.config.load();
  if (config === null) return { code: 69, message: "Desk has no config yet: run desk first" };
  await ports.config.save({ ...config, panel: { ...config.panel, toggleKey: trimmed } });
  return { code: 0, message: `The toggle key is ${trimmed}; run desk to apply it` };
}
