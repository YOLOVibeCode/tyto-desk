/** Waits that double from `first` up to `cap`, and start over after `reset`: how Desk's clients reconnect (§9). */
export class Backoff {
  private readonly first: number;
  private readonly cap: number;
  private wait: number;

  constructor(first: number, cap: number) {
    this.first = first;
    this.cap = cap;
    this.wait = first;
  }

  /** The next wait, in milliseconds. */
  next(): number {
    const wait = this.wait;
    this.wait = Math.min(this.wait * 2, this.cap);
    return wait;
  }

  reset(): void {
    this.wait = this.first;
  }
}
