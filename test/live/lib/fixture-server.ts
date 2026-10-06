import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { waitFor } from "./cdp.ts";

/** What a `/measure` page reported about the window it loaded in. */
export type Report = { tag: string; webdriver: string; chromeHeight: string };

export type FixtureServer = {
  origin: string;
  waitForReport(tag: string): Promise<Report>;
  close(): Promise<void>;
};

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="data:,"></head><body><h1>${title}</h1>${body}</body></html>`;
}

const FIXTURE_PAGE = '<p>Fixture page.</p><a href="/page2.html">Go to page 2</a> <button id="b">Click me</button>';

/**
 * The live suite's web pages, on 127.0.0.1 only, ported from the lab's fixture.mjs. Pages are passive.
 * - `/page1.html`, `/page2.html`: a heading, a link and a button, for agent-browser.
 * - `/measure?tag=<tag>`: once loaded, reports `navigator.webdriver` and the window chrome's height
 *   (`outerHeight - innerHeight`; an infobar adds about 40–56 px) to `/report`.
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
        body = page(
          "measure",
          `<script>addEventListener("load", () => requestAnimationFrame(() => fetch("/report?tag=${tag}&webdriver=" + navigator.webdriver + "&chromeHeight=" + (outerHeight - innerHeight))));</script>`,
        );
        break;
      case "/report":
        reports.push({ tag, webdriver: url.searchParams.get("webdriver") ?? "", chromeHeight: url.searchParams.get("chromeHeight") ?? "" });
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
    waitForReport: (tag) => waitFor(() => reports.find((r) => r.tag === tag), { label: `the ${tag} page's report` }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
