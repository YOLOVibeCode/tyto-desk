/**
 * - `gui-refused`: `guiAllowed` is false here (tests, `DESK_NO_GUI`, anything but the installed launcher or the test
 *   container), so nothing was started.
 * - `failed`: the start command could not run.
 */
export type ChromeStart = { ok: true; pid: number | null } | { ok: false; reason: "gui-refused" | "failed" };

/**
 * The installed Google Chrome (docs/IMPLEMENTATION.md §3, §6.1). Adapter: packages/chrome (macOS `open -n -a`, Linux a
 * detached exec), the only way Desk starts Chrome, always with `chromeArgs`'s arguments.
 */
export interface ChromeProcess {
  /** The installed Chrome's version (`155.0.8059.40`), or `null` when it is not installed. */
  version(): Promise<string | null>;
  start(args: readonly string[]): Promise<ChromeStart>;
}
