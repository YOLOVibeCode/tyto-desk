import { appendFile, chmod, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { SecretRedactor, type LogEvent, type LogSink, type Redactor } from "@desk/core";
import { assertPathAllowed } from "./test-guard.ts";

/** §4.4: each log is at most about 1 MB, and three files are kept. */
const MAX_BYTES = 1_000_000;
const KEEP = 3;

function errorCode(err: unknown): string | undefined {
  return err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

/** The event with the Redactor run over every string in it. */
function redacted(event: LogEvent, redactor: Redactor): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) safe[key] = typeof value === "string" ? redactor.safe(value) : value;
  return safe;
}

/**
 * A Desk log (docs/IMPLEMENTATION.md §3, §4.4): one JSON object per line, `at` and the typed event, the Redactor run on
 * every string; a 0600 file in a 0700 directory; about 1 MB per file, three files kept (`.log`, `.log.1`, `.log.2`).
 * Writes are queued in order and never throw into the process: a log that cannot be written is dropped.
 */
export class FileLogSink implements LogSink {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly redactor: Redactor;
  private queue: Promise<void> = Promise.resolve();

  constructor(path: string, options: { maxBytes?: number; redactor?: Redactor } = {}) {
    this.path = path;
    this.maxBytes = options.maxBytes ?? MAX_BYTES;
    this.redactor = options.redactor ?? new SecretRedactor();
  }

  write(event: LogEvent): void {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...redacted(event, this.redactor) })}\n`;
    this.queue = this.queue.then(() => this.append(line)).catch(() => undefined);
  }

  /** Resolves once every event written so far is on disk. */
  flushed(): Promise<void> {
    return this.queue;
  }

  private async append(line: string): Promise<void> {
    await assertPathAllowed(this.path);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const size = await stat(this.path).then(
      (st) => st.size,
      (err: unknown) => {
        if (errorCode(err) === "ENOENT") return 0;
        throw err;
      },
    );
    if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) {
      for (let i = KEEP - 1; i >= 1; i -= 1) {
        const from = i === 1 ? this.path : `${this.path}.${i - 1}`;
        await rename(from, `${this.path}.${i}`).catch((err: unknown) => {
          if (errorCode(err) !== "ENOENT") throw err;
        });
      }
    }
    await appendFile(this.path, line, { mode: 0o600 });
    await chmod(this.path, 0o600);
  }
}

/** What a process looks like to `logCrashes`: its `uncaughtException`, `unhandledRejection` and `warning` events. */
type CrashSource = { on(event: "uncaughtException" | "unhandledRejection" | "warning", listener: (error: unknown) => void): unknown };

function described(error: unknown): { errorClass: string; code: string | null } {
  const errorClass = error instanceof Error ? (error.name === "Error" ? error.constructor.name : error.name) : typeof error;
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
  return { errorClass: errorClass.slice(0, 64), code: code === null ? null : code.slice(0, 64) };
}

/**
 * §4.4's handlers for a Desk process: an uncaught exception or an unhandled rejection logs only its class and code,
 * never its message or stack (they can quote input), and exits 70; a warning logs its class and code.
 */
export function logCrashes(source: CrashSource, sink: LogSink, exit: (code: number) => void): void {
  source.on("uncaughtException", (error) => {
    sink.write({ event: "crash", ...described(error) });
    exit(70);
  });
  source.on("unhandledRejection", (error) => {
    sink.write({ event: "crash", ...described(error) });
    exit(70);
  });
  source.on("warning", (warning) => sink.write({ event: "warning", ...described(warning) }));
}
