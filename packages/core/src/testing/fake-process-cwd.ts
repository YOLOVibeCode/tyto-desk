import type { ProcessCwd } from "../ports/process-cwd.ts";

/** Each process's directory as the test sets it. */
export class FakeProcessCwd implements ProcessCwd {
  readonly cwds = new Map<number, string>();

  async cwdOf(pid: number): Promise<string | null> {
    return this.cwds.get(pid) ?? null;
  }
}
