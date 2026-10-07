import type { InstanceLock } from "../ports/instance-lock.ts";

/**
 * Locks in memory: a name held by `heldBy[name]` or `holders[name]` (another process, with the build it recorded) refuses
 * until the test frees it.
 */
export class FakeInstanceLock implements InstanceLock {
  readonly heldBy = new Map<string, number>();
  readonly holders = new Map<string, { pid: number; build: string | null }>();
  readonly held = new Set<string>();
  readonly acquired: string[] = [];
  readonly released: string[] = [];

  async acquire(name: string): Promise<{ ok: true; release(): Promise<void> } | { ok: false; heldBy: number }> {
    const holder = this.heldBy.get(name) ?? this.holders.get(name)?.pid;
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

  async holder(name: string): Promise<{ pid: number; build: string | null } | null> {
    const recorded = this.holders.get(name);
    if (recorded !== undefined) return recorded;
    const pid = this.heldBy.get(name);
    return pid === undefined ? null : { pid, build: null };
  }
}
