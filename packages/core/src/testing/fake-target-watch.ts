import type { FollowedBrowser, TargetWatch, TargetWatchEvent } from "../ports/target-watch.ts";

/** A browser socket the test drives: `emit` reports an event, `drop` closes the socket; refused connects give null. */
export class FakeTargetWatch implements TargetWatch {
  readonly followed: string[] = [];
  refuse = false;
  private current: { onEvent: (event: TargetWatchEvent) => void; close: () => void } | null = null;

  async follow(wsUrl: string, onEvent: (event: TargetWatchEvent) => void): Promise<FollowedBrowser | null> {
    this.followed.push(wsUrl);
    if (this.refuse) return null;
    let close = () => undefined as void;
    const closed = new Promise<void>((resolve) => {
      close = () => {
        if (this.current?.close === close) this.current = null;
        resolve();
      };
    });
    this.current = { onEvent, close };
    return { closed, close };
  }

  /** Whether a socket is open now. */
  get following(): boolean {
    return this.current !== null;
  }

  emit(event: TargetWatchEvent): void {
    this.current?.onEvent(event);
  }

  /** The browser socket closes (Chrome quit, restarted or crashed). */
  drop(): void {
    this.current?.close();
  }
}
