import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { targets } from "./lib/cdp.ts";
import { startDeskChrome } from "./lib/chrome.ts";
import { startFixtureServer } from "./lib/fixture-server.ts";
import { LIVE_PORTS } from "./lib/ports.ts";
import { saveResult } from "./lib/results.ts";

const run = promisify(execFile);
const PORT = LIVE_PORTS.agentBrowser;

type Step = { args: string[]; ok: boolean; ms: number; out: string };

/**
 * agent-browser as a Desk pane will run it: plain commands, with AGENT_BROWSER_CONFIG naming a config whose `cdp` is
 * the Desk port and AGENT_BROWSER_SESSION naming the session, under a fresh HOME and an explicit environment.
 */
async function agentBrowser(): Promise<(...args: string[]) => Promise<Step>> {
  const home = await mkdtemp(join(tmpdir(), "agent-browser-home-"));
  const config = join(home, "agent-browser.json");
  await writeFile(config, `${JSON.stringify({ cdp: `http://127.0.0.1:${PORT}`, restoreSave: "never" })}\n`, { mode: 0o600 });
  const env = {
    HOME: home,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: tmpdir(),
    LANG: "C.UTF-8",
    AGENT_BROWSER_CONFIG: config,
    AGENT_BROWSER_SESSION: "desk-live",
  };
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

describe("agent-browser in the live container", () => {
  it("agent-browser 0.38.1 opens, snapshots and creates a tab over the port", async () => {
    const fixture = await startFixtureServer();
    const chrome = await startDeskChrome({ name: "agent-browser", port: PORT });
    try {
      const ab = await agentBrowser();
      const version = await ab("--version");
      const opened = await ab("open", `${fixture.origin}/page2.html`);
      const snapshot = await ab("snapshot", "-i");
      const pagesBefore = (await targets(chrome.cdp)).filter((t) => t.type === "page").length;
      const tabbed = await ab("tab", "new", `${fixture.origin}/page1.html`);
      const pages = (await targets(chrome.cdp)).filter((t) => t.type === "page");
      const closed = await ab("close");
      await saveResult("agent-browser", { steps: [version, opened, snapshot, tabbed, closed], pagesBefore, pagesAfter: pages.length });

      expect(version.out).toBe("agent-browser 0.38.1");
      expect(opened).toMatchObject({ ok: true, out: expect.stringContaining("Fixture Two") });
      expect(snapshot).toMatchObject({ ok: true, out: expect.stringMatching(/heading "Fixture Two"[\s\S]*button "Click me"/) });
      expect(tabbed.ok).toBe(true);
      expect(pages).toHaveLength(pagesBefore + 1);
      expect(pages.map((p) => p.url)).toContain(`${fixture.origin}/page1.html`);
      expect(closed.ok).toBe(true);
    } finally {
      expect(await chrome.close()).toEqual({ code: 0, signal: null });
      await fixture.close();
    }
  });
});
