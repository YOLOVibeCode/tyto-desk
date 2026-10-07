/**
 * The port of a Chrome browser endpoint on loopback, as `/json/version` names it (`ws://127.0.0.1:<port>/devtools/browser/<id>`),
 * or `null` for any other URL: another host or a name for it, TLS, credentials, a page's endpoint, a query or fragment.
 */
export function browserEndpointPort(wsUrl: string): number | null {
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || url.port === "") return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  if (!/^\/devtools\/browser\/[^/]+$/.test(url.pathname)) return null;
  return Number(url.port);
}
