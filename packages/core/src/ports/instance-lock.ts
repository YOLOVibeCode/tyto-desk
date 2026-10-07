/**
 * One holder per name, across processes (docs/IMPLEMENTATION.md §3): `run/<name>.lock` naming the holder's pid. A dead
 * holder's lock is reclaimed. Adapter: packages/node.
 */
export interface InstanceLock {
  acquire(name: string): Promise<{ ok: true; release(): Promise<void> } | { ok: false; heldBy: number }>;
}
