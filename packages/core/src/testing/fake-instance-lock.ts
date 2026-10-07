import type { InstanceLock } from "../ports/instance-lock.ts";

/** Locks in memory: a name held by `heldBy[name]` (another process) refuses until the test frees it. */
export class FakeInstanceLock implements InstanceLock {
  readonly heldBy = new Map<string, number>();
  readonly held = new Set<string>();
  readonly acquired: string[] = [];
  readonly released: string[] = [];

  async acquire(name: string): Promise<{ ok: true; release(): Promise<void> } | { ok: false; heldBy: number }> {
    const holder = this.heldBy.get(name);
    if (holder !== undefined) return { ok: false, heldBy: holder };
    if (this.held.has(name)) return { ok: false, heldBy: 1 };
    this.held.add(name);
    this.acquired.push(name);
    return {
      ok: true,
      release: async () => {
        this.held.delete(name);
        this.released.push(name);
      },
    };
  }
}
