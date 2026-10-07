import type { LogEvent } from "../log/events.ts";

/** A Desk process's log (docs/IMPLEMENTATION.md §3, §4.4): typed events only. Adapter: packages/node (`FileLogSink`). */
export interface LogSink {
  write(event: LogEvent): void;
}
