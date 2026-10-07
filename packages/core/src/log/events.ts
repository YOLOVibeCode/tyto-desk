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
  | { event: "consent"; operation: "quit-all" | "daemon-restart"; exit: number };
