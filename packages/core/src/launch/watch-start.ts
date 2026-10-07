import type { Clock } from "../ports/clock.ts";
import type { DetachedSpawner } from "../ports/detached-spawner.ts";
import type { InstanceLock } from "../ports/instance-lock.ts";
import type { ProcessSignals } from "../ports/process-signals.ts";
import type { DaemonCommand } from "../nmhost/host.ts";
import { pollUntil } from "./poll.ts";

/** §6.6: how long an older `desk watch` gets to release its lock after SIGTERM. */
const WATCH_LOCK_MS = 10_000;
const POLL_MS = 100;

export type WatchStartPorts = { lock: InstanceLock; signals: ProcessSignals; spawner: DetachedSpawner; clock: Clock };

/**
 * §6.1 step 13: a live `desk watch` of this version is left running, unless `replace` (the raw or guarded port moved,
 * D107). One of another version, or one being replaced, gets SIGTERM, which closes its guarded endpoint and releases
 * `run/watch.lock`, and up to 10 s to do so; then the current version's watch starts detached. The daemon and its shells
 * are never touched. `false` when no watch of this version could be started.
 */
export async function ensureWatch(ports: WatchStartPorts, input: { command: DaemonCommand; version: string; replace: boolean }): Promise<boolean> {
  const holder = await ports.lock.holder("watch");
  if (holder !== null && holder.build === input.version && !input.replace) return true;
  if (holder !== null) {
    await ports.signals.terminate(holder.pid);
    const freed = await pollUntil(ports.clock, WATCH_LOCK_MS, POLL_MS, async () => ((await ports.lock.holder("watch")) === null ? true : null));
    if (freed === null) return false;
  }
  return (await ports.spawner.spawn(input.command.file, input.command.args, input.command.env)) !== null;
}
