import type { ShellProbe } from "../ports/shell-probe.ts";

/** Each process's terminal and whether it has children, as the test sets them. */
export class FakeShellProbe implements ShellProbe {
  readonly ttys = new Map<number, string>();
  readonly busy = new Set<number>();

  async ttyOf(pid: number): Promise<string | null> {
    return this.ttys.get(pid) ?? null;
  }

  async hasChildren(pid: number): Promise<boolean> {
    return this.busy.has(pid);
  }
}
