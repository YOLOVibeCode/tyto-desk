import type { MirrorScreen, TerminalMirror } from "../ports/terminal-mirror.ts";

/**
 * A mirror whose writes are parsed at once, or, while `holding`, only at `release()`: a test can hold output mid-parse.
 * Its snapshot is `<screen "…">` around everything parsed, so a test sees what a snapshot holds.
 */
export class FakeMirrorScreen implements MirrorScreen {
  written = "";
  holding = false;
  altScreen = false;
  disposed = false;
  readonly sizes: [number, number][] = [];
  private pending: { data: string; done: () => void }[] = [];
  private flushes: (() => void)[] = [];

  write(data: string): Promise<void> {
    if (!this.holding) {
      this.written += data;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.pending.push({ data, done: resolve }));
  }

  flush(): Promise<void> {
    if (this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.flushes.push(resolve));
  }

  /** Parses every held write, then answers the flushes waiting on them. */
  release(): void {
    this.holding = false;
    for (const write of this.pending) {
      this.written += write.data;
      write.done();
    }
    this.pending = [];
    for (const flushed of this.flushes) flushed();
    this.flushes = [];
  }

  resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows]);
  }

  snapshot(): { data: string; altScreen: boolean } {
    return { data: `<screen ${JSON.stringify(this.written)}>`, altScreen: this.altScreen };
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** Records each mirror it makes. */
export class FakeTerminalMirror implements TerminalMirror {
  readonly screens: FakeMirrorScreen[] = [];

  create(): FakeMirrorScreen {
    const screen = new FakeMirrorScreen();
    this.screens.push(screen);
    return screen;
  }

  /** The `index`th mirror, failing the test when there is none. */
  screen(index = 0): FakeMirrorScreen {
    const screen = this.screens[index];
    if (screen === undefined) throw new Error(`no mirror #${index}`);
    return screen;
  }
}
