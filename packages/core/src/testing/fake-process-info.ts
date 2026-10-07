import type { ProcessInfo } from "../ports/process-info.ts";

/** The pids in `live` are alive; `started` holds when each started (ms since the epoch), unknown when it has none. */
export class FakeProcessInfo implements ProcessInfo {
  readonly live: Set<number>;
  readonly started = new Map<number, number>();
  /** Each live process's argument line; `argsUnknown` makes the list unreadable. */
  readonly args = new Map<number, string>();
  argsUnknown = false;

  constructor(live: Iterable<number> = []) {
    this.live = new Set(live);
  }

  async alive(pid: number): Promise<boolean> {
    return this.live.has(pid);
  }

  async startedAt(pid: number): Promise<number | null> {
    return this.live.has(pid) ? (this.started.get(pid) ?? null) : null;
  }

  async withArgument(argument: string): Promise<number[] | null> {
    if (this.argsUnknown) return null;
    return [...this.args].filter(([pid, line]) => this.live.has(pid) && ` ${line} `.includes(` ${argument} `)).map(([pid]) => pid);
  }
}
