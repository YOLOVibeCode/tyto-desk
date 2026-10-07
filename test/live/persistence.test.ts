import { readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESK_EXTENSION_ID, parseDeskConfig } from "../../packages/core/src/index.ts";
import { Cdp, attach, evaluate, targets, waitFor, type TargetInfo } from "./lib/cdp.ts";
import { browserVersion } from "./lib/chrome.ts";
import { installDesk, runAnswering, userEnv, type InstalledDesk, type Run } from "./lib/desk-run.ts";
import { startFixtureServer, type FixtureServer } from "./lib/fixture-server.ts";
import { LIVE_PORTS } from "./lib/ports.ts";
import { saveFile, saveResult } from "./lib/results.ts";
import { readScreen, screenPng } from "./lib/screen.ts";

const PORT = LIVE_PORTS.persistence;
const PANEL_URL = `chrome-extension://${DESK_EXTENSION_ID}/panel.html`;
const CYCLES = 10;
/** State older than this survived every SIGKILL in the labs (SPEC §5.6, IMPLEMENTATION §13). */
const CRASH_SAFE_MS = 41_000;
/** A fake login for Chrome's password manager: never a real one. */
const LOGIN = { username: "desk-lab", password: "desk-fixture-pass" };

type State = { cookies: string; local: string | null; idb: string | null; crash: string | null };
type Tabs = { urls: string[]; history: string[] };

let installed: InstalledDesk | undefined;
let fixture: FixtureServer | undefined;
let cdp: Cdp | undefined;

function setup(): { installed: InstalledDesk; fixture: FixtureServer } {
  if (installed === undefined || fixture === undefined) throw new Error("Desk did not start (see the beforeAll failure)");
  return { installed, fixture };
}

function chrome(): Cdp {
  if (cdp === undefined) throw new Error("no CDP connection to the Desk Chrome");
  return cdp;
}

const answering = () => browserVersion(PORT).then(() => true, () => false);

/** Connects (again) to the Desk Chrome's browser session. */
async function reconnect(): Promise<Cdp> {
  cdp?.close();
  cdp = await Cdp.connect((await browserVersion(PORT)).webSocketDebuggerUrl);
  return cdp;
}

/** Runs `desk` and fails with its output unless it exits 0. */
async function launchDesk(): Promise<Run> {
  const run = await setup().installed.desk();
  if (run.code !== 0) throw new Error(`desk exited ${run.code}: ${run.stderr.trim()}`);
  return run;
}

/** Opens `url` in a background tab, waits until it loaded, runs `expression` there, and closes the tab again. */
async function inTab<T>(url: string, expression: string): Promise<T> {
  const browser = chrome();
  const { targetId } = await browser.send<{ targetId: string }>("Target.createTarget", { url, background: true });
  try {
    const session = await attach(browser, targetId);
    await waitFor(() => evaluate<boolean>(browser, session, `location.href === ${JSON.stringify(url)} && document.readyState === "complete"`), {
      label: `${url} loaded`,
    });
    return await evaluate<T>(browser, session, expression, 10_000);
  } finally {
    await browser.send("Target.closeTarget", { targetId }).catch(() => undefined);
  }
}

/** Opens the given chrome:// page in a background tab, waits for `api` on it, runs `expression`, and closes the tab. */
async function inWebUi<T>(url: string, api: string, expression: string): Promise<T> {
  const browser = chrome();
  const { targetId } = await browser.send<{ targetId: string }>("Target.createTarget", { url, background: true });
  try {
    const session = await attach(browser, targetId);
    await waitFor(() => evaluate<boolean>(browser, session, `typeof chrome === "object" && typeof chrome.${api} === "object"`), { label: `chrome.${api} on ${url}` });
    return await evaluate<T>(browser, session, expression, 10_000);
  } finally {
    await browser.send("Target.closeTarget", { targetId }).catch(() => undefined);
  }
}

const IDB_PUT = `new Promise((resolve, reject) => {
  const open = indexedDB.open("desk", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("kv");
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const tx = open.result.transaction("kv", "readwrite");
    tx.objectStore("kv").put("1", "desk_idb");
    tx.oncomplete = () => { open.result.close(); resolve(true); };
    tx.onerror = () => reject(tx.error);
  };
})`;

const IDB_GET = `new Promise((resolve) => {
  const open = indexedDB.open("desk", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("kv");
  open.onerror = () => resolve(null);
  open.onsuccess = () => {
    const db = open.result;
    const get = db.transaction("kv").objectStore("kv").get("desk_idb");
    get.onsuccess = () => { db.close(); resolve(get.result ?? null); };
    get.onerror = () => { db.close(); resolve(null); };
  };
})`;

/** The fixture origin's cookies, localStorage, IndexedDB and crash marker, read from a fresh tab of that origin. */
function readState(origin: string): Promise<State> {
  return inTab<State>(
    `${origin}/page1.html?probe=read`,
    `(async () => ({ cookies: document.cookie, local: localStorage.getItem("desk_local"), idb: await ${IDB_GET}, crash: localStorage.getItem("desk_crash") }))()`,
  );
}

/** The usernames Chrome's password manager holds for any site; never a password. */
function savedUsernames(): Promise<string[]> {
  return inWebUi<string[]>(
    "chrome://password-manager/passwords",
    "passwordsPrivate",
    "chrome.passwordsPrivate.getSavedPasswordList().then((list) => list.map((entry) => entry.username))",
  );
}

/** The fixture tabs' URLs, sorted, and tab A's back history. */
async function readTabs(origin: string): Promise<Tabs> {
  const browser = chrome();
  const pages = (await targets(browser)).filter((t) => t.type === "page" && t.url.startsWith(origin) && !t.url.includes("probe="));
  const tabA = pages.find((t) => t.url.includes("tab=a"));
  let history: string[] = [];
  if (tabA !== undefined) {
    const session = await attach(browser, tabA.targetId);
    const nav = await browser.send<{ entries: { url: string }[] }>("Page.getNavigationHistory", {}, { sessionId: session });
    history = nav.entries.map((entry) => entry.url.replace(origin, ""));
    await browser.send("Target.detachFromTarget", { sessionId: session }).catch(() => undefined);
  }
  return { urls: pages.map((t) => t.url.replace(origin, "")).sort(), history };
}

const EXPECTED_TABS: Tabs = { urls: ["/page1.html?tab=b", "/page2.html?tab=a", "/page2.html?tab=c"], history: ["/page1.html?tab=a", "/page2.html?tab=a"] };

/** The Desk Chrome's main pid, from its profile's SingletonLock (`<host>-<pid>`). */
async function chromePid(deskHome: string): Promise<number> {
  const parsed = parseDeskConfig(await readFile(join(deskHome, "config.json"), "utf8"));
  if (!parsed.ok) throw new Error("config.json did not parse");
  const lock = await readlink(join(parsed.config.chrome.userDataDir, "SingletonLock"));
  const pid = Number(/-(\d+)$/.exec(lock)?.[1]);
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("no pid in SingletonLock");
  return pid;
}

describe("Chrome keeps everything (slice 3a) in the live container", () => {
  beforeAll(async () => {
    installed = await installDesk({ port: PORT, resultTag: "persistence" });
    fixture = await startFixtureServer();
    const first = await launchDesk();
    await saveResult("persistence-first-launch", first);
    await reconnect();
    const origin = fixture.origin;

    // Site data: persistent and session cookies, localStorage, IndexedDB.
    await inTab(
      `${origin}/page1.html?probe=write`,
      `(async () => {
        document.cookie = "desk_persist=1; Max-Age=31536000; path=/";
        document.cookie = "desk_session=1; path=/";
        localStorage.setItem("desk_local", "1");
        return await ${IDB_PUT};
      })()`,
    );
    // A saved password, added as Chrome's password manager adds one.
    await inWebUi(
      "chrome://password-manager/passwords",
      "passwordsPrivate",
      `chrome.passwordsPrivate.addPassword({ url: ${JSON.stringify(`${origin}/page1.html`)}, username: ${JSON.stringify(LOGIN.username)}, password: ${JSON.stringify(LOGIN.password)}, note: "", useAccountStore: false }).then(() => true)`,
    );
    // Three tabs; tab A has back history.
    const browser = chrome();
    const { targetId: tabA } = await browser.send<{ targetId: string }>("Target.createTarget", { url: `${origin}/page1.html?tab=a`, background: true });
    const sessionA = await attach(browser, tabA);
    await waitFor(() => evaluate<boolean>(browser, sessionA, 'document.readyState === "complete"'), { label: "tab A loaded" });
    await browser.send("Page.navigate", { url: `${origin}/page2.html?tab=a` }, { sessionId: sessionA });
    await waitFor(() => evaluate<boolean>(browser, sessionA, 'location.search === "?tab=a" && location.pathname === "/page2.html" && document.readyState === "complete"'), {
      label: "tab A on page 2",
    });
    await browser.send("Target.createTarget", { url: `${origin}/page1.html?tab=b`, background: true });
    await browser.send("Target.createTarget", { url: `${origin}/page2.html?tab=c`, background: true });
    await waitFor(async () => (await readTabs(origin)).urls.length === 3, { label: "three fixture tabs" });
  }, 240_000);

  afterAll(async () => {
    cdp?.close();
    await fixture?.close();
    if (installed === undefined) return;
    // desk quit --all, answered on a terminal as the operator answers it: Chrome, desk watch and the daemon stop.
    const stopped = await runAnswering(join(installed.home, ".local", "bin", "desk"), ["quit", "--all"], userEnv(installed.home), "y").catch((err: unknown) => ({
      code: -1,
      output: String(err),
    }));
    await saveResult("persistence-quit-all", { ...stopped, chromeAnswering: await answering() });
  }, 60_000);

  it(
    `persistent and session cookies, localStorage, IndexedDB, a saved password and three tabs with back history survive ${CYCLES} quit-and-desk cycles`,
    async () => {
      const { installed: desk, fixture: server } = setup();
      const cycles: { cycle: number; quit: number | null; launch: number | null; state: State; tabs: Tabs; usernames: string[] }[] = [];
      for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
        cdp?.close();
        cdp = undefined;
        const quitRun = await desk.desk(["quit"]);
        const portClosed = !(await answering());
        const launch = await launchDesk();
        await reconnect();
        cycles.push({
          cycle,
          quit: portClosed ? quitRun.code : null,
          launch: launch.code,
          state: await readState(server.origin),
          tabs: await readTabs(server.origin),
          usernames: await savedUsernames(),
        });
      }
      await saveResult("persistence-cycles", cycles);

      for (const result of cycles) {
        expect({ cycle: result.cycle, quit: result.quit, launch: result.launch }).toEqual({ cycle: result.cycle, quit: 0, launch: 0 });
        expect(result.state.cookies).toContain("desk_persist=1");
        expect(result.state.cookies).toContain("desk_session=1");
        expect(result.state.local).toBe("1");
        expect(result.state.idb).toBe("1");
        expect(result.tabs).toEqual(EXPECTED_TABS);
        expect(result.usernames).toContain(LOGIN.username);
      }
    },
    300_000,
  );

  it(
    "after SIGKILL, desk restores the tabs without the Restore pages prompt and keeps state older than 40 s",
    async () => {
      const { installed: desk, fixture: server } = setup();
      await inTab(
        `${server.origin}/page1.html?probe=crash`,
        `(() => { document.cookie = "desk_crash=1; Max-Age=31536000; path=/"; localStorage.setItem("desk_crash", "1"); return true; })()`,
      );
      // The precondition, not the success condition: the state must be older than the labs' 40 s crash window.
      await new Promise((resolve) => setTimeout(resolve, CRASH_SAFE_MS));

      const pid = await chromePid(desk.deskHome);
      cdp?.close();
      cdp = undefined;
      process.kill(pid, "SIGKILL");
      await waitFor(async () => !(await answering()), { label: "the killed Chrome's port to close", timeoutMs: 15_000 });
      const launch = await launchDesk();
      await reconnect();
      const tabs = await readTabs(server.origin);
      const state = await readState(server.origin);
      await saveFile("persistence-after-crash.png", screenPng(await readScreen()));
      await saveResult("persistence-crash", { launch, tabs, state });

      expect(tabs).toEqual(EXPECTED_TABS);
      expect(state.cookies).toContain("desk_crash=1");
      expect(state.crash).toBe("1");
      expect(state.cookies).toContain("desk_persist=1");
    },
    180_000,
  );

  it(
    "after chrome://restart, Chrome answers on the same port with the same profile",
    async () => {
      const { fixture: server } = setup();
      const before = await browserVersion(PORT);
      await chrome()
        .send("Target.createTarget", { url: "chrome://restart" })
        .catch(() => undefined);
      cdp?.close();
      cdp = undefined;
      const after = await waitFor(
        async () => {
          const version = await browserVersion(PORT).catch(() => null);
          return version !== null && version.webSocketDebuggerUrl !== before.webSocketDebuggerUrl ? version : null;
        },
        { label: "Chrome back on the same port with a new browser id", timeoutMs: 45_000 },
      );
      await reconnect();
      const state = await readState(server.origin);
      const usernames = await savedUsernames();
      await saveResult("persistence-restart", { before: before.webSocketDebuggerUrl, after: after.webSocketDebuggerUrl, state, usernames });

      expect(state.cookies).toContain("desk_persist=1");
      expect(state.local).toBe("1");
      expect(usernames).toContain(LOGIN.username);
    },
    120_000,
  );

  it(
    "after the last window is closed and Chrome quits, desk opens a window with the panel",
    async () => {
      const { installed: desk, fixture: server } = setup();
      // Chrome restarted on its own above, without the extension (desk watch reopens it from slice 3b): quit and start it.
      await desk.desk(["quit"]);
      await launchDesk();
      await reconnect();
      const pages = (await targets(chrome())).filter((t) => t.type === "page");
      for (const page of pages) await chrome().send("Target.closeTarget", { targetId: page.targetId }).catch(() => undefined);
      cdp?.close();
      cdp = undefined;
      await waitFor(async () => !(await answering()), { label: "Chrome quitting after its last window closed", timeoutMs: 20_000 });

      const launch = await launchDesk();
      await reconnect();
      const panel = await waitFor(async () => (await targets(chrome())).find((t: TargetInfo) => t.url === PANEL_URL), { label: "the Desk panel" });
      const restored = (await targets(chrome())).filter((t) => t.type === "page" && t.url !== PANEL_URL).map((t) => t.url.replace(server.origin, ""));
      const windows = await Promise.all(
        [panel, ...(await targets(chrome())).filter((t) => t.type === "page")].map((t) =>
          chrome()
            .send<{ windowId: number }>("Browser.getWindowForTarget", { targetId: t.targetId })
            .then((answer) => answer.windowId, () => null),
        ),
      );
      await saveResult("persistence-last-window", { launch, restored, windows });

      expect(launch.code).toBe(0);
      expect(panel.url).toBe(PANEL_URL);
    },
    120_000,
  );
});
