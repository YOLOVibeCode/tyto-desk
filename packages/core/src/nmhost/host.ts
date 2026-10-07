import { DESK_EXTENSION_ORIGIN } from "../extension/desk-extension.ts";
import type { Clock } from "../ports/clock.ts";
import type { DaemonDialer } from "../ports/daemon-dialer.ts";
import type { DetachedSpawner } from "../ports/detached-spawner.ts";
import type { HostState } from "../protocol/messages.ts";

/** How long the host keeps trying the daemon it started (§6.6: host → daemon connect, including starting it). */
export const DAEMON_START_MS = 3_000;

/** The first wait between connects after a start; each doubles, up to the cap. */
const FIRST_RETRY_MS = 25;
const RETRY_CAP_MS = 400;

/** A process to start: what the native host runs to start the current version's daemon. */
export type DaemonCommand = { file: string; args: readonly string[]; env: Readonly<Record<string, string>> };

export type HostInput<Link> = {
  /** The caller origin Chrome passed as the host's first argument. */
  origin: string | undefined;
  dialer: DaemonDialer<Link>;
  spawner: DetachedSpawner;
  clock: Clock;
  /** The current version's daemon, resolved once; `null` when no version is current. */
  daemonCommand(): Promise<DaemonCommand | null>;
};

/**
 * - `foreign-origin`: Chrome started the host for an origin that is not the Desk extension's; nothing was contacted.
 * - `no-current-version`: the daemon is down and no installed version is current to start it from.
 * - `daemon-unreachable`: the daemon did not answer, even after a start and 3 s of retries.
 */
export type HostStart<Link> =
  | { ok: true; link: Link; started: boolean }
  | { ok: false; reason: "foreign-origin" | "no-current-version" | "daemon-unreachable" };

/**
 * How `desk-nmhost` reaches the daemon (docs/IMPLEMENTATION.md §8). It serves only the Desk extension: any other caller
 * origin ends it before it contacts anything. When the daemon's socket is dead (missing or refusing) it starts the
 * current version's daemon detached and retries with backoff for 3 s; any other failure starts nothing.
 */
export async function startHost<Link>(input: HostInput<Link>): Promise<HostStart<Link>> {
  if (input.origin !== DESK_EXTENSION_ORIGIN) return { ok: false, reason: "foreign-origin" };
  const first = await input.dialer.connect();
  if (first.ok) return { ok: true, link: first.link, started: false };
  if (first.reason !== "dead") return { ok: false, reason: "daemon-unreachable" };
  const command = await input.daemonCommand();
  if (command === null) return { ok: false, reason: "no-current-version" };
  const pid = await input.spawner.spawn(command.file, command.args, command.env);
  if (pid === null) return { ok: false, reason: "daemon-unreachable" };
  const deadline = input.clock.now() + DAEMON_START_MS;
  let wait = FIRST_RETRY_MS;
  for (;;) {
    const attempt = await input.dialer.connect();
    if (attempt.ok) return { ok: true, link: attempt.link, started: true };
    const left = deadline - input.clock.now();
    if (left <= 0) return { ok: false, reason: "daemon-unreachable" };
    await input.clock.sleep(Math.min(wait, left));
    wait = Math.min(wait * 2, RETRY_CAP_MS);
  }
}

/**
 * What the host tells the panel before it ends, when it could not reach a daemon (§9's panel states): no current
 * version means the install is damaged; a daemon that never answered means it is unreachable. A caller that is not the
 * Desk extension is told nothing.
 */
export function hostStateFor(reason: "foreign-origin" | "no-current-version" | "daemon-unreachable"): HostState | null {
  if (reason === "no-current-version") return { type: "host", state: "install-damaged" };
  if (reason === "daemon-unreachable") return { type: "host", state: "no-daemon" };
  return null;
}
