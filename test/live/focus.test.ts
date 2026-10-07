import { execFile } from "node:child_process";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DaemonExtensionBridge, UnixDaemonClient } from "../../packages/cli/src/index.ts";
import { Cdp, attach, evaluate, waitFor } from "./lib/cdp.ts";
import { browserVersion } from "./lib/chrome.ts";
import { installDesk, runAnswering, runProgram, userEnv, type InstalledDesk } from "./lib/desk-run.ts";
import { startFixtureServer, type FixtureServer } from "./lib/fixture-server.ts";
import { LIVE_PORTS } from "./lib/ports.ts";
import { saveResult } from "./lib/results.ts";

const run = promisify(execFile);
const RAW = LIVE_PORTS.focus;
const GUARDED = `http://127.0.0.1:${RAW + 1}`;
const PANE = "p_k2m9q3x7ab";

type Step = { args: string[]; ok: boolean; out: string; activeAfter: string | null; userVisible: string };

let installed: InstalledDesk | undefined;
let fixture: FixtureServer | undefined;
let cdp: Cdp | undefined;
let userTab = "";
/** The test's own raw-port session on the user's tab: no focus emulation, so its visibility is the real one. */
let userSession = "";
let bridge: DaemonExtensionBridge | undefined;

function setup(): { installed: InstalledDesk; fixture: FixtureServer; cdp: Cdp } {
  if (installed === undefined || fixture === undefined || cdp === undefined) throw new Error("Desk did not start (see the beforeAll failure)");
  return { installed, fixture, cdp };
}

async function getJson(url: string): Promise<unknown> {
  const answer = await fetch(url, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
  return answer === null || !answer.ok ? null : answer.json();
}

/**
 * The tab you are looking at: Chrome's own active tab of the last-focused window (`chrome.tabs`, through the daemon, as
 * `desk tab current` reads it). An agent page's `document.visibilityState` cannot tell, because the focus guard's focus
 * emulation makes the agent's background page report itself visible.
 */
async function activeTab(): Promise<string | null> {
  if (bridge === undefined) throw new Error("no extension bridge");
  return bridge.tabCurrent();
}

/** The user's tab's own visibility, on a session without focus emulation: `visible` only while it is in front. */
async function userVisibility(): Promise<string> {
  return evaluate<string>(setup().cdp, userSession, "document.visibilityState").catch(() => "error");
}

/** agent-browser with its own session and a config whose `cdp` is `endpoint`. */
async function agentBrowser(endpoint: string, session: string): Promise<(...args: string[]) => Promise<Step>> {
  const home = await mkdtemp(join(tmpdir(), "agent-browser-home-"));
  const config = join(home, "agent-browser.json");
  await writeFile(config, `${JSON.stringify({ cdp: endpoint, restoreSave: "never", pinTab: true })}\n`, { mode: 0o600 });
  const env = { HOME: home, PATH: "/usr/local/bin:/usr/bin:/bin", TMPDIR: tmpdir(), LANG: "C.UTF-8", AGENT_BROWSER_CONFIG: config, AGENT_BROWSER_SESSION: session };
  return async (...args: string[]) => {
    let ok = true;
    let out = "";
    try {
      out = (await run("agent-browser", args, { env, signal: AbortSignal.timeout(30_000) })).stdout.trim();
    } catch (err) {
      const failure = err as { stdout?: string; stderr?: string; message?: string };
      ok = false;
      out = `${failure.stdout ?? ""}${failure.stderr ?? failure.message ?? ""}`.trim();
    }
    return { args, ok, out, activeAfter: await activeTab(), userVisible: await userVisibility() };
  };
}

/** Makes the user's fixture tab the active one again, through the raw port, as a person clicking it would. */
async function lookAtUserTab(): Promise<void> {
  await setup().cdp.send("Target.activateTarget", { targetId: userTab });
  await waitFor(async () => (await activeTab()) === userTab && (await userVisibility()) === "visible", { label: "the user's tab in front" });
}

/** An agent's working session: open, read, click, screenshot, and move between its tabs. */
async function agentWork(ab: (...args: string[]) => Promise<Step>, origin: string): Promise<Step[]> {
  const steps = [await ab("open", `${origin}/form.html?agent=1`), await ab("snapshot", "-i"), await ab("click", "#b"), await ab("screenshot")];
  steps.push(await ab("tab", "new", `${origin}/page2.html?agent=2`));
  const list = await ab("tab");
  steps.push(list);
  steps.push(await ab("tab", /\bt\d+\b/.exec(list.out)?.[0] ?? "t1"));
  steps.push(await ab("eval", "document.title"));
  return steps;
}

describe("the focus guard (slice 4b) in the live container", () => {
  beforeAll(async () => {
    installed = await installDesk({ port: RAW, resultTag: "focus" });
    fixture = await startFixtureServer();
    const launch = await installed.desk();
    if (launch.code !== 0) throw new Error(`desk exited ${launch.code}: ${launch.stderr.trim()}`);
    await waitFor(() => getJson(`${GUARDED}/json/version`), { label: "desk watch's guarded endpoint", timeoutMs: 20_000 });
    cdp = await Cdp.connect((await browserVersion(RAW)).webSocketDebuggerUrl);
    userTab = (await cdp.send<{ targetId: string }>("Target.createTarget", { url: `${fixture.origin}/page1.html?user=1` })).targetId;
    userSession = await attach(cdp, userTab);
    bridge = new DaemonExtensionBridge(new UnixDaemonClient(join(installed.deskHome, "run", "ptyd.sock"), "live"));
    await lookAtUserTab();
  }, 240_000);

  afterAll(async () => {
    cdp?.close();
    await fixture?.close();
    if (installed === undefined) return;
    await runAnswering(join(installed.home, ".local", "bin", "desk"), ["quit", "--all"], userEnv(installed.home), "y").catch(() => undefined);
  }, 60_000);

  it(
    "the user's active tab and focused view do not change when an agent opens or uses its tab",
    async () => {
      const { fixture: server } = setup();
      // The measurement without the guard: the same work on the raw port.
      const unguarded = await agentWork(await agentBrowser(`http://127.0.0.1:${RAW}`, "desk-focus-raw"), server.origin);
      const tookTheTab = unguarded.some((step) => step.activeAfter !== userTab);
      await lookAtUserTab();
      const guarded = await agentWork(await agentBrowser(GUARDED, "desk-focus-guarded"), server.origin);
      await saveResult("focus-measurement", { userTab, unguarded, guarded, unguardedTookTheTab: tookTheTab });

      expect(guarded.filter((step) => !step.ok).map((step) => `${step.args.join(" ")}: ${step.out.slice(0, 160)}`)).toEqual([]);
      expect(guarded.map((step) => ({ step: step.args.join(" "), active: step.activeAfter === userTab, visible: step.userVisible }))).toEqual(
        guarded.map((step) => ({ step: step.args.join(" "), active: true, visible: "visible" })),
      );
    },
    240_000,
  );

  it(
    "screenshot, snapshot and click work on a background agent tab",
    async () => {
      const { fixture: server } = setup();
      await lookAtUserTab();
      const ab = await agentBrowser(GUARDED, "desk-focus-background");
      const opened = await ab("open", `${server.origin}/form.html?background=1`);
      const snapshot = await ab("snapshot", "-i");
      const clicked = await ab("click", "#b");
      const title = await ab("eval", "document.title");
      const shot = await ab("screenshot");
      const path = /(\/\S+\.png)/.exec(shot.out)?.[1];
      const size = path === undefined ? 0 : (await stat(path).catch(() => ({ size: 0 }))).size;
      await saveResult("focus-background-tab", { opened, snapshot, clicked, title, shot, size });

      expect([opened, snapshot, clicked, title, shot].every((step) => step.ok)).toBe(true);
      expect(snapshot.out).toMatch(/button "Click me"/);
      expect(title.out).toContain("clicked");
      expect(size).toBeGreaterThan(1_000);
      expect([opened, snapshot, clicked, title, shot].every((step) => step.activeAfter === userTab && step.userVisible === "visible")).toBe(true);
    },
    120_000,
  );

  it("desk tab current answers with the active tab of the last-focused Desk window", async () => {
    const { installed: desk } = setup();
    await lookAtUserTab();

    const current = await desk.desk(["tab", "current"]);
    await saveResult("focus-tab-current", { current, userTab });

    expect(current).toMatchObject({ code: 0 });
    expect(current.stdout.trim()).toBe(userTab);
  });

  it("desk tab mine returns the pane's grouped tab and creates it in the background when missing", async () => {
    const { installed: desk } = setup();
    await lookAtUserTab();
    const env = { ...userEnv(desk.home), DESK_PANE: PANE };
    const launcher = join(desk.home, ".local", "bin", "desk");

    const first = await runProgram(launcher, ["tab", "mine"], env, 30_000);
    const second = await runProgram(launcher, ["tab", "mine"], env, 30_000);
    const active = await activeTab();
    await saveResult("focus-tab-mine", { first, second, active, userTab });

    expect(first.code).toBe(0);
    expect(second.stdout.trim()).toBe(first.stdout.trim());
    expect(first.stdout.trim()).toMatch(/^[0-9A-F]{32}$/);
    expect(active).toBe(userTab);
  });
});
