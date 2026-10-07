/**
 * Every line a Desk log holds (docs/IMPLEMENTATION.md §4.4): a closed union whose strings are enum members or Desk
 * ids, never text from a client, a page, a shell or a parser. The `Redactor` still runs on every string before disk.
 */
export type LogEvent =
  | { event: "bad-line"; size: number }
  | { event: "line-refused"; size: number }
  | { event: "state-recovered"; file: "layout" | "panes" | "config" }
  | { event: "crash"; errorClass: string; code: string | null }
  | { event: "warning"; errorClass: string; code: string | null }
  | { event: "shutdown"; mode: "stop" | "restart" }
  | { event: "consent"; operation: "quit-all" | "daemon-restart"; exit: number }
  /** `desk watch` (§6.4): Chrome came back with a new browser id, and what the watch did about it. */
  | { event: "chrome-returned"; extension: "loaded" | "kept" | "refused"; worker: boolean; panel: "reopened" | "open" | "not-open" | "no-focus-guard" }
  /** `desk watch` follows a Desk Chrome it had not followed before (its first, or one that came back). */
  | { event: "chrome-followed" }
  /** The browser socket closed: the panels open then, how long ago the last one closed (ms, or null), Chrome's exit type. */
  | { event: "chrome-went-away"; panels: number; panelClosedMs: number | null; exitType: string | null }
  | { event: "chrome-relaunched"; within10Minutes: number }
  | { event: "relaunch-stopped"; within10Minutes: number }
  | { event: "idle-quit"; minutes: number }
  | { event: "terminal-attached" }
  /**
   * A Desk panel crashed: how many windows the daemon had panels in, how many lost theirs, and whether the extension was
   * loaded again (a panel crash takes the extension's renderer, and with it the service worker).
   */
  | { event: "panel-crashed"; windows: number; lost: number; extension: "loaded" | "kept" | "refused" }
  | { event: "panel-reopened"; reason: "crashed" }
  | { event: "panel-not-reopened"; step: "no-tab" | "no-focus-guard" | "action-refused" };
