import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESK_EXTENSION_ID } from "../../packages/core/src/index.ts";
import { Cdp, attach, evaluate, targets, waitFor } from "./lib/cdp.ts";
import { browserVersion } from "./lib/chrome.ts";
import { installDesk, runAnswering, userEnv, type InstalledDesk } from "./lib/desk-run.ts";
import { startFixtureServer, type FixtureServer } from "./lib/fixture-server.ts";
import { LIVE_PORTS } from "./lib/ports.ts";
import { saveResult } from "./lib/results.ts";

const run = promisify(execFile);
const RAW = LIVE_PORTS.gateway;
const GUARDED_PORT = RAW + 1;
const GUARDED = `http://127.0.0.1:${GUARDED_PORT}`;
const DESK_PREFIX = `chrome-extension://${DESK_EXTENSION_ID}/`;
/** The image's npm tools (test/live/image/tools): Puppeteer's and Playwright's cores, which only connect. */
const tools = createRequire("/opt/desk-live/tools/node_modules/.desk-live-tools.js");

type Step = { args: string[]; ok: boolean; ms: number; out: string };
type PuppeteerCore = {
  connect(options: { browserURL: string }): Promise<{ targets(): { url(): string }[]; pages(): Promise<{ url(): string }[]>; disconnect(): Promise<void> }>;
};
type PlaywrightCore = {
  chromium: {
    connectOverCDP(url: string): Promise<{ contexts(): { pages(): { url(): string }[] }[]; close(): Promise<void> }>;
  };
};

let installed: InstalledDesk | undefined;
let fixture: FixtureServer | undefined;

function setup(): { installed: InstalledDesk; fixture: FixtureServer } {
  if (installed === undefined || fixture === undefined) throw new Error("Desk did not start (see the beforeAll failure)");
  return { installed, fixture };
}

/** GET on 127.0.0.1 with the right Host, as a CDP client asks; `null` when nothing answers. */
async function getJson(port: number, path: string): Promise<unknown> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
  return answer === null || !answer.ok ? null : answer.json();
}

/** agent-browser as a Desk pane runs it, but with its `cdp` on the guarded endpoint (slice 4b makes that Desk's config). */
async function agentBrowser(session: string): Promise<(...args: string[]) => Promise<Step>> {
  const home = await mkdtemp(join(tmpdir(), "agent-browser-home-"));
  const config = join(home, "agent-browser.json");
  await writeFile(config, `${JSON.stringify({ cdp: GUARDED, restoreSave: "never", pinTab: true })}\n`, { mode: 0o600 });
  const env = { HOME: home, PATH: "/usr/local/bin:/usr/bin:/bin", TMPDIR: tmpdir(), LANG: "C.UTF-8", AGENT_BROWSER_CONFIG: config, AGENT_BROWSER_SESSION: session };
  return async (...args: string[]) => {
    const started = Date.now();
    try {
      const { stdout } = await run("agent-browser", args, { env, signal: AbortSignal.timeout(30_000) });
      return { args, ok: true, ms: Date.now() - started, out: stdout.trim() };
    } catch (err) {
      const failure = err as { stdout?: string; stderr?: string; message?: string };
      return { args, ok: false, ms: Date.now() - started, out: `${failure.stdout ?? ""}${failure.stderr ?? failure.message ?? ""}`.trim() };
    }
  };
}

describe("the guarded endpoint (slice 4a) in the live container", () => {
  beforeAll(async () => {
    installed = await installDesk({ port: RAW, resultTag: "gateway" });
    fixture = await startFixtureServer();
    const launch = await installed.desk();
    await saveResult("gateway-launch", launch);
    if (launch.code !== 0) throw new Error(`desk exited ${launch.code}: ${launch.stderr.trim()}`);
    await waitFor(() => getJson(GUARDED_PORT, "/json/version"), { label: "desk watch's guarded endpoint", timeoutMs: 20_000 });
  }, 240_000);

  afterAll(async () => {
    await fixture?.close();
    if (installed === undefined) return;
    const stopped = await runAnswering(join(installed.home, ".local", "bin", "desk"), ["quit", "--all"], userEnv(installed.home), "y").catch((err: unknown) => ({
      code: -1,
      output: String(err),
    }));
    await saveResult("gateway-quit-all", { ...stopped, guardedAnswering: (await getJson(GUARDED_PORT, "/json/version")) !== null });
  }, 60_000);

  it("desk starts desk watch, whose guarded endpoint points at itself and hides the terminal", async () => {
    const version = (await getJson(GUARDED_PORT, "/json/version")) as { webSocketDebuggerUrl: string };
    const guardedList = (await getJson(GUARDED_PORT, "/json/list")) as { url: string }[];
    const rawList = (await getJson(RAW, "/json/list")) as { url: string }[];
    await saveResult("gateway-lists", { version, guarded: guardedList.map((t) => t.url), raw: rawList.map((t) => t.url) });

    expect(version.webSocketDebuggerUrl).toMatch(new RegExp(`^ws://127\\.0\\.0\\.1:${GUARDED_PORT}/devtools/browser/`));
    expect(rawList.some((t) => t.url.startsWith(DESK_PREFIX))).toBe(true);
    expect(guardedList.some((t) => t.url.startsWith(DESK_PREFIX))).toBe(false);
  });

  it("Playwright and Puppeteer connected to DESK_CDP_URL list no chrome-extension:// page", async () => {
    const puppeteer = tools("puppeteer-core") as PuppeteerCore;
    const { chromium } = tools("playwright-core") as PlaywrightCore;

    const viaPuppeteer = await puppeteer.connect({ browserURL: GUARDED });
    // Every target Puppeteer sees (Chrome's own component extensions' background pages included), and its pages.
    const puppeteerTargets = viaPuppeteer.targets().map((t) => t.url());
    const puppeteerPages = (await viaPuppeteer.pages()).map((p) => p.url());
    await viaPuppeteer.disconnect();
    const viaPlaywright = await chromium.connectOverCDP(GUARDED);
    const playwrightUrls = viaPlaywright.contexts().flatMap((context) => context.pages().map((page) => page.url()));
    const closed = await viaPlaywright.close().then(() => "closed", (err: unknown) => String(err));
    const stillRunning = (await getJson(RAW, "/json/version")) !== null;
    await saveResult("gateway-clients", { puppeteerTargets, puppeteerPages, playwrightUrls, playwrightClose: closed, stillRunning });

    expect(puppeteerPages.filter((url) => url.startsWith("chrome-extension://"))).toEqual([]);
    expect(puppeteerTargets.filter((url) => url.startsWith(DESK_PREFIX))).toEqual([]);
    expect(playwrightUrls.filter((url) => url.startsWith("chrome-extension://"))).toEqual([]);
    expect(stillRunning).toBe(true);
  });

  it(
    "agent-browser's open, snapshot, fill, click, screenshot, errors, network, eval, tab new, tab <id>, a fresh pinned session and inspect work through the guarded endpoint",
    async () => {
      const { fixture: server } = setup();
      const ab = await agentBrowser("desk-live-gateway");
      const steps: Step[] = [];
      const step = async (...args: string[]) => {
        const result = await ab(...args);
        steps.push(result);
        return result;
      };
      await step("open", `${server.origin}/form.html`);
      const snapshot = await step("snapshot", "-i");
      await step("fill", "#q", "desk");
      const value = await step("eval", "document.querySelector('#q').value");
      await step("click", "#b");
      const title = await step("eval", "document.title");
      await step("screenshot");
      await step("errors");
      await step("network", "requests");
      const sum = await step("eval", "1 + 1");
      await step("tab", "new", `${server.origin}/page1.html`);
      const list = await step("tab");
      const first = /\bt\d+\b/.exec(list.out)?.[0] ?? "t1";
      await step("tab", first);
      const fresh = await (await agentBrowser("desk-live-gateway-2"))("open", `${server.origin}/page2.html`);
      steps.push(fresh);
      const inspect = await ab("inspect");
      steps.push(inspect);
      await step("close");
      const rawPages = (await getJson(RAW, "/json/list")) as { url: string }[];
      await saveResult("gateway-agent-browser", { steps, rawPages: rawPages.map((t) => t.url) });

      expect(steps.filter((s) => !s.ok).map((s) => `${s.args.join(" ")}: ${s.out.slice(0, 200)}`)).toEqual([]);
      expect(snapshot.out).toMatch(/button "Click me"/);
      expect(value.out).toContain("desk");
      expect(title.out).toContain("clicked");
      expect(sum.out).toContain("2");
    },
    240_000,
  );

  it("a fixture page cannot open a WebSocket to the debugging port or the guarded endpoint", async () => {
    const { fixture: server } = setup();
    const browserId = ((await browserVersion(RAW)).webSocketDebuggerUrl.split("/").pop() ?? "").trim();
    const cdp = await Cdp.connect((await browserVersion(RAW)).webSocketDebuggerUrl);
    try {
      const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: `${server.origin}/page1.html`, background: true });
      const session = await attach(cdp, targetId);
      await waitFor(() => evaluate<boolean>(cdp, session, 'document.readyState === "complete"'), { label: "the fixture page" });
      const tries = await evaluate<Record<string, string>>(
        cdp,
        session,
        `(async () => {
          const attempt = (url) => new Promise((resolve) => {
            const socket = new WebSocket(url);
            const timer = setTimeout(() => { socket.close(); resolve("timeout"); }, 5000);
            socket.onopen = () => { clearTimeout(timer); socket.close(); resolve("opened"); };
            socket.onerror = () => { clearTimeout(timer); resolve("refused"); };
          });
          return {
            raw: await attempt("ws://127.0.0.1:${RAW}/devtools/browser/${browserId}"),
            guarded: await attempt("ws://127.0.0.1:${GUARDED_PORT}/devtools/browser/${browserId}"),
          };
        })()`,
        15_000,
      );
      await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
      await saveResult("gateway-page-websocket", tries);

      expect(tries).toEqual({ raw: "refused", guarded: "refused" });
    } finally {
      cdp.close();
    }
  });

  it("the guarded endpoint never lists or opens the terminal for a client that asks for it by id", async () => {
    const rawList = (await getJson(RAW, "/json/list")) as { id: string; url: string }[];
    const panel = rawList.find((t) => t.url.startsWith(DESK_PREFIX));
    if (panel === undefined) throw new Error("no Desk target on the raw port");
    const cdp = await Cdp.connect(((await getJson(GUARDED_PORT, "/json/version")) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
    try {
      const listed = await targets(cdp);
      const attachTry = await cdp.send("Target.attachToTarget", { targetId: panel.id, flatten: true }).then(() => "attached", (err: unknown) => String(err));
      await saveResult("gateway-hidden-attach", { listed: listed.map((t) => t.url), attachTry });

      expect(listed.some((t) => t.url.startsWith(DESK_PREFIX))).toBe(false);
      expect(attachTry).toMatch(/refuses Target\.attachToTarget/);
    } finally {
      cdp.close();
    }
  });
});
