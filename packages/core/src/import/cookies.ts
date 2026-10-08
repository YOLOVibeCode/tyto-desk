import type { Cookie } from "../ports/cookie-browser.ts";
import { GOOGLE_ACCOUNT_EXTRA_DOMAINS, GOOGLE_SUPPORTED_DOMAINS } from "./google-domains.ts";

/** Google's device-bound session cookies, by name, on any domain (§14 step 4). */
const GOOGLE_SESSION_NAMES = new Set(["SID", "HSID", "SSID", "APISID", "SAPISID", "LSID"]);
const GOOGLE_SESSION_PATTERN = /^__(Secure|Host)-.*PSID/;
const GOOGLE_DOMAINS = [...GOOGLE_SUPPORTED_DOMAINS, ...GOOGLE_ACCOUNT_EXTRA_DOMAINS].map(bare);

/** A cookie domain without its leading dot, lower case. */
function bare(domain: string): string {
  return domain.replace(/^\./, "").toLowerCase();
}

/** Whether `domain` is `parent` or one of its subdomains. */
function within(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}

/** Whether moving the cookie risks the Google session your main Chrome uses (§14 step 4). */
export function isGoogleAccountCookie(cookie: Cookie): boolean {
  if (GOOGLE_SESSION_NAMES.has(cookie.name) || GOOGLE_SESSION_PATTERN.test(cookie.name)) return true;
  const domain = bare(cookie.domain);
  return GOOGLE_DOMAINS.some((google) => within(domain, google));
}

/** The cookies an import may move: unexpired, and none of Google's account cookies (§14 step 4). */
export function importableCookies(cookies: readonly Cookie[], nowSeconds: number): Cookie[] {
  return cookies.filter((cookie) => (cookie.expires === -1 || cookie.expires > nowSeconds) && !isGoogleAccountCookie(cookie));
}

/**
 * The domains the picker shows, with how many cookies each holds: never a name or a value (§14 step 5). A domain counts
 * under a parent domain that also has cookies (`app.example.test` under `example.test`), and `www.` under its parent.
 */
export function cookieDomains(cookies: readonly Cookie[]): { domain: string; count: number }[] {
  const domains = cookies.map((cookie) => bare(cookie.domain).replace(/^www\./, ""));
  const parents = [...new Set(domains)].sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  const counts = new Map<string, number>();
  for (const domain of domains) {
    const parent = parents.find((candidate) => within(domain, candidate)) ?? domain;
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([domain, count]) => ({ domain, count }));
}

/** The cookies of the named domains and their subdomains. */
export function cookiesFor(cookies: readonly Cookie[], domains: readonly string[]): Cookie[] {
  const wanted = domains.map(bare);
  return cookies.filter((cookie) => wanted.some((domain) => within(bare(cookie.domain), domain)));
}
