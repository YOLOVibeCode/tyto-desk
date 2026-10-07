/**
 * What `desk watch` learns from one browser WebSocket (docs/IMPLEMENTATION.md §6.4). Adapter: packages/chrome
 * (`Target.setDiscoverTargets`, `targetCreated`, `targetInfoChanged`, `targetDestroyed`, `targetCrashed`); it never
 * attaches to a target.
 * - `desk-attached`: a Desk extension target (panel or service worker) turned attached: someone else's debugger.
 * - `panel-crashed`: a Desk panel target crashed (Chrome then closes it). CDP names no window for a side panel, so the
 *   watch learns the window from the daemon (D108).
 * - `panels`: how many Desk panel targets exist now, after any change.
 */
export type TargetWatchEvent =
  | { type: "desk-attached" }
  | { type: "panel-crashed" }
  | { type: "panels"; open: number };

/** One followed browser socket: `closed` settles when it closes (Chrome went away, or `close()`). */
export type FollowedBrowser = { closed: Promise<void>; close(): void };

export interface TargetWatch {
  /** Follows the browser at `wsUrl`; `null` when it could not connect. */
  follow(wsUrl: string, onEvent: (event: TargetWatchEvent) => void): Promise<FollowedBrowser | null>;
}
