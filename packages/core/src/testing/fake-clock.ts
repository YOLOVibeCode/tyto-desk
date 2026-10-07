import type { Clock } from "../ports/clock.ts";

type Sleeper = { at: number; resolve: () => void };

/**
 * Virtual time. By default a sleep waits until the test calls `advance`; with `{ auto: true }` every sleep moves time
 * forward at once, so a plan that polls with a budget runs to its end without a real wait. Every sleep is recorded.
 */
export class FakeClock implements Clock {
  private time: number;
  private readonly auto: boolean;
  private sleepers: Sleeper[] = [];
  readonly sleeps: number[] = [];

  constructor(options: { start?: number; auto?: boolean } = {}) {
    this.time = options.start ?? 1_760_000_000_000;
    this.auto = options.auto ?? false;
  }

  now(): number {
    return this.time;
  }

  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    if (this.auto) {
      this.time += ms;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.sleepers.push({ at: this.time + ms, resolve }));
  }

  /** Moves time forward and wakes every sleep that is due, in order; awaits so their continuations run. */
  async advance(ms: number): Promise<void> {
    const until = this.time + ms;
    for (;;) {
      const due = this.sleepers.filter((s) => s.at <= until).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.sleepers = this.sleepers.filter((s) => s !== due);
      this.time = Math.max(this.time, due.at);
      due.resolve();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    }
    this.time = until;
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }

  /** How many sleeps are waiting. */
  pending(): number {
    return this.sleepers.length;
  }
}
