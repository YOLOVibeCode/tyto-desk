import type { Tmux } from "../ports/tmux.ts";

/** A tmux server that runs or not, with its global update-environment names. */
export class FakeTmux implements Tmux {
  running: boolean;
  names: readonly string[];
  calls = 0;

  constructor(options: { running: boolean; names?: readonly string[] }) {
    this.running = options.running;
    this.names = options.names ?? [];
  }

  async serverRunning(): Promise<boolean> {
    this.calls += 1;
    return this.running;
  }

  async updateEnvironment(): Promise<readonly string[] | null> {
    this.calls += 1;
    return this.running ? this.names : null;
  }

  readonly appended: (readonly string[])[] = [];

  async appendUpdateEnvironment(names: readonly string[]): Promise<boolean> {
    if (!this.running) return false;
    this.appended.push(names);
    this.names = [...this.names, ...names];
    return true;
  }
}
