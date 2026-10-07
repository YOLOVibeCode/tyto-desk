import type { Pty, PtyExit, PtySpawnOptions, PtySpawner } from "../ports/pty-spawner.ts";

/** A process the test drives: it records what was written to it, its sizes and signals, and emits output on request. */
export class FakePty implements Pty {
  readonly pid: number;
  readonly written: string[] = [];
  readonly sizes: [number, number][] = [];
  readonly signals: string[] = [];
  paused = false;
  private readonly dataListeners: ((data: string) => void)[] = [];
  private readonly exitListeners: ((exit: PtyExit) => void)[] = [];

  constructor(pid: number) {
    this.pid = pid;
  }

  write(data: string): void {
    this.written.push(data);
  }

  resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows]);
  }

  kill(signal: "SIGHUP" | "SIGKILL"): void {
    this.signals.push(signal);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener);
  }

  onExit(listener: (exit: PtyExit) => void): void {
    this.exitListeners.push(listener);
  }

  /** The process prints `data`. */
  print(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  /** The process ends. */
  end(exit: PtyExit): void {
    for (const listener of this.exitListeners) listener(exit);
  }
}

/** Records every spawn; each gets a FakePty with the next pid, or fails while `failing` is set. */
export class FakePtySpawner implements PtySpawner {
  readonly spawned: { options: PtySpawnOptions; pty: FakePty }[] = [];
  failing = false;
  private nextPid = 4100;

  spawn(options: PtySpawnOptions): { ok: true; pty: FakePty } | { ok: false } {
    if (this.failing) return { ok: false };
    const pty = new FakePty(this.nextPid);
    this.nextPid += 1;
    this.spawned.push({ options, pty });
    return { ok: true, pty };
  }

  /** The pty of the `index`th spawn, failing the test when there is none. */
  pty(index = 0): FakePty {
    const entry = this.spawned[index];
    if (entry === undefined) throw new Error(`no spawn #${index}`);
    return entry.pty;
  }
}
