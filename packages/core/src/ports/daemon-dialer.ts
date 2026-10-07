/**
 * - `dead`: nothing listens on the daemon's socket (it is missing, or refuses: ENOENT, ECONNREFUSED), so the native
 *   host may start the daemon.
 * - `failed`: anything else (permissions, a timeout); the host starts nothing.
 */
export type DialResult<Link> = { ok: true; link: Link } | { ok: false; reason: "dead" | "failed" };

/** The native host's connection to the daemon's socket (docs/IMPLEMENTATION.md §3, §8). Adapter: packages/nmhost. */
export interface DaemonDialer<Link> {
  connect(): Promise<DialResult<Link>>;
}
