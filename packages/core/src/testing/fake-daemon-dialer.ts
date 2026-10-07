import type { DaemonDialer, DialResult } from "../ports/daemon-dialer.ts";

/** Answers each connect with the next scripted result, repeating the last one; every connect is counted. */
export class FakeDaemonDialer<Link> implements DaemonDialer<Link> {
  private results: DialResult<Link>[];
  private index = 0;
  connects = 0;

  constructor(results: DialResult<Link>[]) {
    this.results = results;
  }

  async connect(): Promise<DialResult<Link>> {
    const result = this.results[Math.min(this.index, this.results.length - 1)];
    this.index += 1;
    this.connects += 1;
    if (result === undefined) throw new Error("FakeDaemonDialer has no scripted result");
    return result;
  }

  /** From now on every connect answers `result`. */
  answer(result: DialResult<Link>): void {
    this.results = [result];
    this.index = 0;
  }
}
