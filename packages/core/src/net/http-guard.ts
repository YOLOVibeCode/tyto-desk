/** The two headers every Desk listener checks, as the request carried them (`undefined` when absent). */
export type HttpGuardRequest = {
  /** The listener's own port. */
  port: number;
  host: string | undefined;
  origin: string | undefined;
};

export type HttpGuardResult = { ok: true } | { ok: false; status: 403 | 500 };

/**
 * Chrome's own rules for its debugging port, applied by every Desk listener to plain requests and upgrades alike:
 * any `Origin` header is refused with 403 (web pages always send one), and a `Host` other than
 * `127.0.0.1:<port>` or `localhost:<port>` with 500 (DNS rebinding). Callers add no CORS headers.
 */
export function httpGuard(request: HttpGuardRequest): HttpGuardResult {
  if (request.origin !== undefined) return { ok: false, status: 403 };
  const host = request.host?.toLowerCase();
  if (host !== `127.0.0.1:${request.port}` && host !== `localhost:${request.port}`) return { ok: false, status: 500 };
  return { ok: true };
}
