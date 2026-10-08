import { base64Decode } from "../bytes/base64.ts";
import { utf8Decode } from "../bytes/utf8-decode.ts";

/** Tab titles show at most this many characters (§10). */
export const TITLE_MAX = 200;
/** The most text an OSC 52 write may put on the clipboard. */
const CLIPBOARD_MAX = 2 ** 20;
/** An http or https URL with a host, and nothing a URL never holds (blanks, controls). */
const WEB_URL = /^https?:\/\/[^\s/?#]+[^\s]*$/i;

/**
 * A title a program set (OSC 0 or 2, or tmux's) as the tab strip shows it: without control characters, trimmed, cut at
 * 200 characters; `null` when nothing is left. It is shown as text (`textContent`), so markup stays markup.
 */
export function tabTitle(raw: string): string | null {
  const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return clean === "" ? null : [...clean].slice(0, TITLE_MAX).join("");
}

/** The URL a clicked link opens in a new Desk tab (§10): http or https, and only on Cmd+click; else `null`. */
export function linkTarget(uri: string, click: { meta: boolean }): string | null {
  return click.meta && WEB_URL.test(uri) && !/[\u0000-\u001f\u007f]/.test(uri) ? uri : null;
}

/**
 * The text an OSC 52 sequence asks to put on the clipboard (`<selection>;<base64>`), or `null`: a read (`?`) is always
 * ignored, and a write needs `terminal.osc52Write` (§10).
 */
export function osc52Write(data: string, allowed: boolean): string | null {
  if (!allowed) return null;
  const at = data.indexOf(";");
  const payload = at < 0 ? data : data.slice(at + 1);
  if (payload === "?" || payload.length > (CLIPBOARD_MAX * 4) / 3 + 4) return null;
  const bytes = base64Decode(payload);
  if (bytes === null) return null;
  const text = utf8Decode(bytes);
  return text.length > CLIPBOARD_MAX ? null : text;
}
