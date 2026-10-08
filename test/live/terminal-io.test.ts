import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESK_EXTENSION_ID } from "../../packages/core/src/index.ts";
import { Cdp, attach, evaluate, targets, waitFor, type TargetInfo } from "./lib/cdp.ts";
import { browserVersion } from "./lib/chrome.ts";
import { installDesk, runAnswering, userEnv, type InstalledDesk } from "./lib/desk-run.ts";
import { LIVE_PORTS } from "./lib/ports.ts";
import { saveFile, saveResult } from "./lib/results.ts";

const PORT = LIVE_PORTS.terminal;
const PANEL_URL = `chrome-extension://${DESK_EXTENSION_ID}/panel.html`;

type Panel = { cdp: Cdp; target: TargetInfo; session: string; pane: string };

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

/** Connects to the Desk Chrome and its panel (the first one, or the one in `windowTarget`'s window), once its pane is up. */
async function connectPanel(prompt = true): Promise<Panel> {
  panel?.cdp.close();
  const cdp = await Cdp.connect((await browserVersion(PORT)).webSocketDebuggerUrl);
  // The panel that owns the pane: another window's panel shows "open in another window" instead.
  const found = await waitFor(
    async () => {
      for (const candidate of (await targets(cdp)).filter((t) => t.url.startsWith(PANEL_URL))) {
        const attached = await attach(cdp, candidate.targetId);
        const banner = await evaluate<string>(cdp, attached, "typeof deskTest === 'object' ? deskTest.banner() : 'loading'").catch(() => "loading");
        if (banner !== "loading" && !banner.includes("another window")) return { target: candidate, session: attached };
      }
      return null;
    },
    { label: "the Desk panel that owns the pane" },
  );
  const { target, session } = found;
  // Typed text reaches the panel's focused element even when its window is not the one with the X focus.
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, { sessionId: session });
  const pane = await waitFor(() => evaluate<string | null>(cdp, session, "typeof deskTest === 'object' && deskTest.panes().length > 0 ? deskTest.panes()[0] : null"), {
    label: "the panel's pane",
  });
  panel = { cdp, target, session, pane };
  if (prompt) await waitFor(async () => (await screen()).includes("desk-live %"), { label: "a prompt", timeoutMs: 30_000 });
  return panel;
}

function screen(of: Panel = current()): Promise<string> {
  return evaluate<string>(of.cdp, of.session, `deskTest.screen(${JSON.stringify(of.pane)})`);
}

/** The screen's lines, without the cursor's blank tail. */
async function lines(of: Panel = current()): Promise<string[]> {
  return (await screen(of)).split("\n").map((line) => line.trimEnd());
}

async function typeText(text: string, of: Panel = current()): Promise<void> {
  await evaluate(of.cdp, of.session, "document.querySelector('textarea.xterm-helper-textarea')?.focus(), true");
  await of.cdp.send("Input.insertText", { text }, { sessionId: of.session });
}

async function typeLine(text: string, of: Panel = current()): Promise<void> {
  await typeText(text, of);
  for (const type of ["keyDown", "keyUp"]) {
    await of.cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) }, { sessionId: of.session });
  }
}

/** Quits the Desk Chrome the way the operator would, starts it again, and reconnects to the panel. */
async function quitAndRelaunch(prompt = true): Promise<Panel> {
  current().cdp.close();
  panel = undefined;
  const quit = await desk().desk(["quit"]);
  if (quit.code !== 0) throw new Error(`desk quit exited ${quit.code}`);
  const launch = await desk().desk();
  if (launch.code !== 0) throw new Error(`desk exited ${launch.code}: ${launch.stderr.trim()}`);
  return connectPanel(prompt);
}

const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((p / 100) * values.length))] ?? -1;

describe("the terminal's I/O (slice 2b) in the live container", () => {
  beforeAll(async () => {
    installed = await installDesk({ port: PORT, resultTag: "terminal" });
    const launch = await installed.desk();
    if (launch.code !== 0) throw new Error(`desk exited ${launch.code}: ${launch.stderr.trim()}`);
    await connectPanel();
  }, 240_000);

  afterAll(async () => {
    panel?.cdp.close();
    if (installed === undefined) return;
    // The daemon's and the hosts' logs, for a failure's report.
    const logs = join(installed.deskHome, "logs");
    for (const name of await readdir(logs).catch(() => [])) await saveFile(`terminal-log-${name}`, await readFile(join(logs, name)));
    await runAnswering(join(installed.home, ".local", "bin", "desk"), ["quit", "--all"], userEnv(installed.home), "y").catch(() => undefined);
  }, 60_000);

  it(
    "after Browser.close and desk, the pane shows the same screen and the same shell pid",
    async () => {
      await typeLine("echo marker-$$");
      const pid = await waitFor(async () => /marker-(\d+)/.exec((await screen()).split("echo marker-$$").pop() ?? "")?.[1], { label: "the shell's pid" });
      const before = await lines();

      await quitAndRelaunch();
      const after = await lines();
      const calls = await evaluate<string[]>(current().cdp, current().session, `deskTest.calls(${JSON.stringify(current().pane)})`);
      await typeLine("echo again-$$");
      const again = await waitFor(async () => /again-(\d+)/.exec((await screen()).split("echo again-$$").pop() ?? "")?.[1], { label: "the pid after" });
      await saveResult("terminal-reattach", { pid, again, before, after, calls });

      expect(after.join("\n")).toContain(`marker-${pid}`);
      expect(again).toBe(pid);
    },
    180_000,
  );

  it(
    "vim and a tmux session with a status line match the mirror after a re-attach",
    async () => {
      await typeLine("vi");
      await waitFor(async () => (await lines()).filter((line) => line === "~").length > 3, { label: "vi's empty buffer" });
      await typeText("iDesk was here\u001b");
      await waitFor(async () => (await screen()).includes("Desk was here"), { label: "vi's text" });
      const vimBefore = await lines();
      await quitAndRelaunch(false);
      await waitFor(async () => (await screen()).includes("Desk was here"), { label: "vi after the re-attach" });
      const vimAfter = await lines();
      await typeText(":q!");
      await typeLine("");
      await waitFor(async () => (await screen()).includes("desk-live %"), { label: "the prompt after vi" });

      // A named window keeps its name: automatic-rename would turn "tmux" into "zsh" between the two snapshots.
      await typeLine("tmux new -s desklive -n main");
      await waitFor(async () => (await screen()).includes("[desklive]"), { label: "tmux's status line", timeoutMs: 20_000 });
      await typeLine("echo inside-tmux");
      await waitFor(async () => (await lines()).includes("inside-tmux"), { label: "output in tmux" });
      const tmuxBefore = await lines();
      await quitAndRelaunch(false);
      await waitFor(async () => (await screen()).includes("[desklive]"), { label: "tmux after the re-attach" });
      const tmuxAfter = await lines();
      await typeLine("tmux kill-session -t desklive");
      await saveResult("terminal-full-screen", { vimBefore, vimAfter, tmuxBefore, tmuxAfter });

      // The panel's height may change across the relaunch (desk watch's alert line), so vi's filler rows may differ.
      const vimText = (shown: string[]) => shown.filter((line) => line !== "~" && line !== "");
      expect(vimText(vimAfter)).toEqual(vimText(vimBefore));
      // tmux's status line ends with a clock, which may move on during the re-attach.
      const steady = (shown: string[]) => shown.filter((line) => line.includes("[desklive]") || line.includes("inside-tmux")).map((line) => line.replace(/\d{1,2}:\d{2}.*$/, ""));
      expect(steady(tmuxAfter)).toEqual(steady(tmuxBefore));
    },
    240_000,
  );

  it(
    "50 MB of output completes and Ctrl+C stops it within 0.5 s",
    async () => {
      await waitFor(async () => (await screen()).includes("desk-live %"), { label: "a prompt", timeoutMs: 20_000 });
      const started = Date.now();
      // fold ends without a newline, so the marker gets a line of its own.
      await typeLine("head -c 50000000 /dev/zero | tr '\\0' x | fold -w 100; echo; echo done-50mb");
      // Progress every 5 s, for a report when it is slow: the panel's writes and resets so far, and its last line.
      const progress: { s: number; writes: number; resets: number; last: string }[] = [];
      const sampler = setInterval(() => {
        const { cdp, session, pane } = current();
        void evaluate<string[]>(cdp, session, `deskTest.calls(${JSON.stringify(pane)})`).then(async (calls) => {
          const shown = await lines();
          progress.push({ s: Math.round((Date.now() - started) / 1000), writes: calls.filter((c) => c.includes(" write ")).length, resets: calls.filter((c) => c.endsWith(" reset")).length, last: (shown.filter(Boolean).at(-1) ?? "").slice(0, 40) });
        }, () => undefined);
      }, 5_000);
      try {
        await waitFor(async () => (await lines()).includes("done-50mb"), { label: "the end of 50 MB", timeoutMs: 180_000, intervalMs: 250 });
      } finally {
        clearInterval(sampler);
        await saveResult("terminal-heavy-progress", progress);
      }
      const fiftyMs = Date.now() - started;

      await typeLine("yes desk-flood");
      await waitFor(async () => (await screen()).includes("desk-flood"), { label: "the flood" });
      const interrupted = Date.now();
      await typeText("\u0003");
      await waitFor(async () => (await lines()).filter(Boolean).at(-1)?.endsWith("desk-live %") === true, { label: "the prompt after Ctrl+C", intervalMs: 20 });
      const stopMs = Date.now() - interrupted;
      await saveResult("terminal-heavy-output", { fiftyMs, stopMs });

      expect(stopMs).toBeLessThanOrEqual(500);
    },
    240_000,
  );

  it(
    "minimizing the window during heavy output never pauses the shell for more than 1 s",
    async () => {
      const { cdp, session } = current();
      // A side panel is in no browser window of its own for CDP; the panel's chrome.windows id is the CDP window id.
      const windowId = await evaluate<number>(cdp, session, "chrome.windows.getCurrent().then((w) => w.id)");
      await typeLine("for i in $(seq 1 400); do date +%s%3N >> ~/ticks; head -c 50000 /dev/zero | tr '\\0' y; echo; done; echo ticks-done");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }).catch(() => undefined);
      await waitFor(async () => (await readFile(join(desk().home, "ticks"), "utf8").catch(() => "")).trim().split("\n").length >= 400, {
        label: "the loop's 400 ticks",
        timeoutMs: 120_000,
        intervalMs: 500,
      });
      const ticks = (await readFile(join(desk().home, "ticks"), "utf8")).trim().split("\n").map(Number);
      const gaps = ticks.slice(1).map((tick, index) => tick - (ticks[index] ?? tick));
      await saveResult("terminal-minimized", { ticks: ticks.length, maxGapMs: Math.max(...gaps) });

      expect(Math.max(...gaps)).toBeLessThanOrEqual(1_000);
    },
    180_000,
  );

  it(
    "a pane opened in a second window moves there, and the first window offers to bring it back",
    async () => {
      const first = current();
      const { targetId: page } = await first.cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", newWindow: true });
      const { windowId } = await first.cdp.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId: page });
      const tabs = (await first.cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets", { filter: [{ type: "tab" }] })).targetInfos;
      let tab = page;
      for (const candidate of tabs) {
        const answer = await first.cdp.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId: candidate.targetId }).catch(() => null);
        if (answer?.windowId === windowId) tab = candidate.targetId;
      }

      await first.cdp.send("Extensions.triggerAction", { id: DESK_EXTENSION_ID, targetId: tab });
      const banner = await waitFor(
        async () => {
          const text = await evaluate<string>(first.cdp, first.session, "deskTest.banner()");
          return text.includes("open in another window") ? text : null;
        },
        { label: "the first panel's offer", timeoutMs: 20_000 },
      );
      const panels = (await targets(first.cdp)).filter((t) => t.url.startsWith(PANEL_URL)).length;
      // Bring it here, then close the second window: the first panel owns the pane again, in a window nothing covers.
      await evaluate(first.cdp, first.session, "document.querySelector('#banner button')?.click(), true");
      const back = await waitFor(async () => ((await evaluate<string>(first.cdp, first.session, "deskTest.banner()")) === "" ? true : null), {
        label: "the pane back in the first window",
      }).catch(() => false);
      await first.cdp.send("Target.closeTarget", { targetId: page }).catch(() => undefined);
      await saveResult("terminal-second-window", { banner, panels, back });

      expect(banner).toContain("Bring it here");
      expect(panels).toBe(2);
      expect(back).toBe(true);
    },
    120_000,
  );

  it(
    "keystroke-to-echo p50 and p95 are recorded",
    async () => {
      const second = await connectPanel(false);
      // The pane's owner, in the window the second-window test left in front, at a prompt.
      await waitFor(async () => (await screen(second)).trimEnd().endsWith("desk-live %"), { label: "a prompt", timeoutMs: 20_000 });
      await typeLine("cat", second);
      await waitFor(async () => /\ncat\n?$/.test((await screen(second)).trimEnd() + "\n") || (await screen(second)).trimEnd().endsWith("cat"), { label: "cat running" });
      const times: number[] = [];
      for (let i = 0; i < 40; i += 1) {
        const mark = String.fromCharCode(97 + (i % 26));
        const before = (await screen(second)).length;
        const started = performance.now();
        await typeText(mark, second);
        await waitFor(async () => (await screen(second)).length > before, { label: `echo of ${mark}`, intervalMs: 2 });
        times.push(performance.now() - started);
      }
      await typeText("\u0003", second);
      const result = { p50: Math.round(percentile(times, 50) * 10) / 10, p95: Math.round(percentile(times, 95) * 10) / 10, samples: times.length };
      await saveResult("terminal-keystroke-latency", result);

      expect(result.samples).toBe(40);
      expect(result.p50).toBeGreaterThan(0);
    },
    120_000,
  );
});
