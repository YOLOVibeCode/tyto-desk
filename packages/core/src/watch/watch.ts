import type { GuardedEndpoint } from "../ports/guarded-endpoint.ts";
import type { InstanceLock } from "../ports/instance-lock.ts";

export type WatchPorts = { lock: InstanceLock; endpoint: GuardedEndpoint };

/**
 * `desk watch` (docs/IMPLEMENTATION.md §6.4). One instance, under `run/watch.lock` (whose record names its build), serves
 * the guarded endpoint until `until` settles (SIGTERM, SIGHUP), then closes the endpoint and releases the lock. A second
 * watch exits 0 at once; a taken guarded port exits 75. Slice 3b adds relaunch, idle quit, the panel's reopen and alerts.
 */
export async function runWatch(ports: WatchPorts, until: Promise<void>): Promise<0 | 75> {
  const lock = await ports.lock.acquire("watch");
  if (!lock.ok) return 0;
  try {
    const listening = await ports.endpoint.listen();
    if (!listening.ok) return 75;
    await until;
    await ports.endpoint.close();
    return 0;
  } finally {
    await lock.release();
  }
}
