/**
 * One holder per name, across processes (docs/IMPLEMENTATION.md §3): `run/<name>.lock` naming the holder's pid. A dead
 * holder's lock is reclaimed. Adapter: packages/node.
 */
export interface InstanceLock {
  acquire(name: string): Promise<{ ok: true; release(): Promise<void> } | { ok: false; heldBy: number }>;
  /** The live holder of `run/<name>.lock`, by the same rule `acquire` uses, and the build it recorded; `null` when free. */
  holder(name: string): Promise<{ pid: number; build: string | null } | null>;
}
