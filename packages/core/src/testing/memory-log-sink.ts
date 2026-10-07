import type { LogEvent } from "../log/events.ts";
import type { LogSink } from "../ports/log-sink.ts";

/** Keeps every event written. */
export class MemoryLogSink implements LogSink {
  readonly events: LogEvent[] = [];

  write(event: LogEvent): void {
    this.events.push(event);
  }
}
