import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { waitFor } from "./cdp.ts";

/** One reading a `/measure` page sent about the window it loaded in. */
export type Report = { tag: string; webdriver: string; chromeHeight: string; atMs: number; settled: boolean };

/** A page's readings, and the one it took once the window had settled. */
export type Measurement = { settled: Report; readings: Report[] };

export type FixtureServer = {
  origin: string;
  /** Waits for the `/measure?tag=<tag>` page's settled reading. */
  waitForSettled(tag: string): Promise<Measurement>;
  close(): Promise<void>;
};

/** A window counts as settled this long after the page loaded, once two readings in a row agree. */
export const SETTLE_MS = 3_000;
const READING_EVERY_MS = 250;
const GIVE_UP_MS = 12_000;

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="data:,"></head><body><h1>${title}</h1>${body}</body></html>`;
}

const FIXTURE_PAGE = '<p>Fixture page.</p><a href="/page2.html">Go to page 2</a> <button id="b">Click me</button>';

/**
 * Reads `navigator.webdriver` and the window chrome's height (`outerHeight - innerHeight`; an infobar adds about
 * 40–56 px) every 250 ms from the load event, and sends each reading to `/report`. The last reading, marked settled, is
 * the first taken at least SETTLE_MS after the page loaded that equals the one before it: an infobar that appears after
 * first paint, which is what the comparison is for, is in it.
 */
function measureScript(tag: string): string {
  return `<script>
addEventListener("load", () => {
  const loaded = performance.now();
  let previous = null;
  const read = () => {
    const height = outerHeight - innerHeight;
    const atMs = Math.round(performance.now() - loaded);
    const settled = (atMs >= ${SETTLE_MS} && height === previous) || atMs >= ${GIVE_UP_MS};
    previous = height;
    fetch("/report?tag=${tag}&webdriver=" + navigator.webdriver + "&chromeHeight=" + height + "&atMs=" + atMs + "&settled=" + (settled ? 1 : 0));
    if (!settled) setTimeout(read, ${READING_EVERY_MS});
  };
  requestAnimationFrame(read);
});
</script>`;
}

/**
 * The live suite's web pages, on 127.0.0.1 only, ported from the lab's fixture.mjs. Pages are passive.
 * - `/page1.html`, `/page2.html`: a heading, a link and a button, for agent-browser.
 * - `/measure?tag=<tag>`: reports the window's readings to `/report` until the window settles (measureScript).
 */
export async function startFixtureServer(): Promise<FixtureServer> {
  const reports: Report[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const tag = (url.searchParams.get("tag") ?? "").replace(/[^a-z0-9-]/g, "");
    let body = "";
    let type = "text/html; charset=utf-8";
    let status = 200;
    switch (url.pathname) {
      case "/page1.html":
        body = page("Fixture One", FIXTURE_PAGE);
        break;
      case "/page2.html":
        body = page("Fixture Two", FIXTURE_PAGE);
        break;
      case "/measure":
        body = page("measure", measureScript(tag));
        break;
      case "/report":
        reports.push({
          tag,
          webdriver: url.searchParams.get("webdriver") ?? "",
          chromeHeight: url.searchParams.get("chromeHeight") ?? "",
          atMs: Number(url.searchParams.get("atMs") ?? "-1"),
          settled: url.searchParams.get("settled") === "1",
        });
        type = "text/plain";
        body = "ok";
        break;
      default:
        status = 404;
        type = "text/plain";
        body = "not found";
    }
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    waitForSettled: async (tag) => {
      const settled = await waitFor(() => reports.find((r) => r.tag === tag && r.settled), {
        label: `the ${tag} page's settled reading`,
        timeoutMs: 30_000,
      });
      return { settled, readings: reports.filter((r) => r.tag === tag) };
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
