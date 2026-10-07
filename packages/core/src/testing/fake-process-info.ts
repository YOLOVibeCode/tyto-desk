import type { ProcessInfo } from "../ports/process-info.ts";

/** The pids in `live` are alive. */
export class FakeProcessInfo implements ProcessInfo {
  readonly live: Set<number>;

  constructor(live: Iterable<number> = []) {
    this.live = new Set(live);
  }

  async alive(pid: number): Promise<boolean> {
    return this.live.has(pid);
  }
}
