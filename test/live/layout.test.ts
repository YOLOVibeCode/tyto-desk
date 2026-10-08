import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESK_EXTENSION_ID, type LayoutShown } from "../../packages/core/src/index.ts";
import { Cdp, attach, evaluate, targets, waitFor, type TargetInfo } from "./lib/cdp.ts";
import { browserVersion } from "./lib/chrome.ts";
import { installDesk, runAnswering, userEnv, type InstalledDesk } from "./lib/desk-run.ts";
import { LIVE_PORTS } from "./lib/ports.ts";
import { saveFile, saveResult } from "./lib/results.ts";

const PORT = LIVE_PORTS.layout;
const PANEL_URL = `chrome-extension://${DESK_EXTENSION_ID}/panel.html`;
const WORKER_URL = `chrome-extension://${DESK_EXTENSION_ID}/sw.js`;

type Panel = { cdp: Cdp; target: TargetInfo; session: string };

let installed: InstalledDesk | undefined;
let panel: Panel | undefined;

function desk(): InstalledDesk {
  if (installed === undefined) throw new Error("Desk did not start (see the beforeAll failure)");
  return installed;
}

function current(): Panel {
  if (panel === undefined) throw new Error("no panel");
  return panel;
}

async function browser(): Promise<Cdp> {
  return Cdp.connect((await browserVersion(PORT)).webSocketDebuggerUrl);
}

/** Connects to the Desk panel once its test hooks are up. */
async function connectPanel(): Promise<Panel> {
  panel?.cdp.close();
  const cdp = await browser();
  const target = await waitFor(async () => (await targets(cdp)).find((t) => t.url.startsWith(PANEL_URL)), { label: "the Desk panel", timeoutMs: 30_000 });
  const session = await attach(cdp, target.targetId);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, { sessionId: session });
  await waitFor(() => evaluate<boolean>(cdp, session, "typeof deskTest === 'object' && deskTest.layout() !== null"), { label: "the panel's layout" });
  panel = { cdp, target, session };
  return panel;
}

function shown(of: Panel = current()): Promise<LayoutShown | null> {
  return evaluate<LayoutShown | null>(of.cdp, of.session, "deskTest.layout()");
}

async function act(name: string, argument?: number): Promise<void> {
  await evaluate(current().cdp, current().session, `deskTest.action(${JSON.stringify(name)}${argument === undefined ? "" : `, ${argument}`}), true`);
}

/** Every pane the panel holds shows a prompt. */
async function prompts(of: Panel = current()): Promise<void> {
  await waitFor(
    async () => {
      const panes = await evaluate<string[]>(of.cdp, of.session, "deskTest.panes()");
      for (const pane of panes) if (!(await evaluate<string>(of.cdp, of.session, `deskTest.screen(${JSON.stringify(pane)})`)).includes("desk-live %")) return false;
      return panes.length > 0;
    },
    { label: "a prompt in every pane", timeoutMs: 30_000 },
  );
}

/** Each tab's tree, as the layout hook shows the active one: tab by tab, made active in turn. */
async function trees(): Promise<unknown[]> {
  const tabs = (await shown())?.tabs ?? [];
  const all: unknown[] = [];
  for (let n = 1; n <= tabs.length; n += 1) {
    await act("tab", n);
    all.push((await shown())?.root ?? null);
  }
  return all;
}

/** The nearest-rank percentile: of 20 values, p95 is the 19th smallest, so one slow outlier is not the p95. */
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil((p / 100) * values.length) - 1)] ?? -1;

describe("the panel's tabs and splits (slice 6a) in the live container", () => {
  beforeAll(async () => {
    installed = await installDesk({ port: PORT, resultTag: "layout" });
    const launch = await installed.desk();
    if (launch.code !== 0) throw new Error(`desk exited ${launch.code}: ${launch.stderr.trim()}`);
    await connectPanel();
    await prompts();
  }, 240_000);

  afterAll(async () => {
    panel?.cdp.close();
    if (installed === undefined) return;
    const logs = join(installed.deskHome, "logs");
    for (const name of await readdir(logs).catch(() => [])) await saveFile(`layout-log-${name}`, await readFile(join(logs, name)));
    await runAnswering(join(installed.home, ".local", "bin", "desk"), ["quit", "--all"], userEnv(installed.home), "y").catch(() => undefined);
  }, 60_000);

  it(
    "three panes in two tabs come back with the same layout after quit and desk",
    async () => {
      await act("split-right");
      await act("new-tab");
      await waitFor(async () => (await shown())?.tabs.length === 2, { label: "two tabs" });
      await prompts();
      const before = await trees();

      current().cdp.close();
      panel = undefined;
      const quit = await desk().desk(["quit"]);
      const launch = await desk().desk();
      await connectPanel();
      await prompts();
      const after = await trees();
      await saveResult("layout-restored", { quit: quit.code, launch, before, after });

      expect(before.flatMap((tree) => JSON.stringify(tree).match(/p_\w{10}/g) ?? [])).toHaveLength(3);
      expect(after).toEqual(before);
    },
    240_000,
  );

  it(
    "showing the hidden panel with 4 panes takes input within 300 ms p95",
    async () => {
      // Four panes in the active tab.
      await act("tab", 1);
      while (((await shown())?.root === null ? 0 : (JSON.stringify((await shown())?.root).match(/p_\w{10}/g) ?? []).length) < 4) await act("split-down");
      await prompts();
      const cdp = await browser();
      const worker = await attach(cdp, (await waitFor(async () => (await targets(cdp)).find((t) => t.url === WORKER_URL), { label: "the worker" })).targetId);
      const windowId = await evaluate<number>(cdp, worker, "chrome.windows.getLastFocused().then((w) => w.id)");
      const ready: number[] = [];
      for (let run = 0; run < 20; run += 1) {
        current().cdp.close();
        panel = undefined;
        await evaluate(cdp, worker, `chrome.sidePanel.close({ windowId: ${windowId} }).then(() => true)`);
        await waitFor(async () => !(await targets(cdp)).some((t) => t.url.startsWith(PANEL_URL)), { label: "the panel closed" });
        // The toolbar action, on a tab target (the kind `Target.getTargets` lists only when asked for tabs).
        const tab = await waitFor(
          async () => {
            const listed = await cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets", { filter: [{ type: "tab" }] });
            return listed.targetInfos.find((t) => t.type === "tab" && !t.url.startsWith("chrome-extension://")) ?? null;
          },
          { label: "a tab target" },
        );
        await cdp.send("Extensions.triggerAction", { id: DESK_EXTENSION_ID, targetId: tab.targetId });
        await connectPanel();
        // When the last pane of the active tab took its snapshot (a reset, then the write after it), in the panel's
        // own clock, which starts as Chrome begins to load it.
        const at = await waitFor(
          async () => {
            const view = await shown();
            const panes = view?.root === null || view === null ? [] : (JSON.stringify(view.root).match(/p_\w{10}/g) ?? []);
            if (panes.length < 4) return null;
            const times: number[] = [];
            for (const pane of panes) {
              const calls = await evaluate<string[]>(current().cdp, current().session, `deskTest.calls(${JSON.stringify(pane)})`);
              const reset = calls.findIndex((call) => call.endsWith(" reset"));
              const write = calls.slice(reset + 1).find((call) => call.includes(" write "));
              if (reset < 0 || write === undefined) return null;
              times.push(Number(write.split(" ")[0]));
            }
            return Math.max(...times);
          },
          { label: "four attached panes", timeoutMs: 20_000 },
        );
        ready.push(at);
      }
      cdp.close();
      const p95 = percentile(ready, 95);
      await saveResult("layout-show-4-panes", { ready, p50: percentile(ready, 50), p95 });

      expect(p95).toBeLessThanOrEqual(300);
    },
    300_000,
  );
});
