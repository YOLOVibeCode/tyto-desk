import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESK_EXTENSION_ID, type LayoutShown } from "../../packages/core/src/index.ts";
import { Cdp, attach, evaluate, targets, waitFor } from "./lib/cdp.ts";
import { browserVersion } from "./lib/chrome.ts";
import { installDesk, runAnswering, userEnv, type InstalledDesk } from "./lib/desk-run.ts";
import { LIVE_PORTS } from "./lib/ports.ts";
import { saveFile, saveResult } from "./lib/results.ts";

const PORT = LIVE_PORTS.keys;
const PANEL_URL = `chrome-extension://${DESK_EXTENSION_ID}/panel.html`;
/** CDP's modifier bits. */
const ALT = 1;
const META = 4;

let installed: InstalledDesk | undefined;
let cdp: Cdp | undefined;
let session = "";

function browser(): Cdp {
  if (cdp === undefined) throw new Error("Desk did not start (see the beforeAll failure)");
  return cdp;
}

const shown = () => evaluate<LayoutShown | null>(browser(), session, "deskTest.layout()");
const focused = () => evaluate<string | null>(browser(), session, "deskTest.focused()");
const screen = async (pane?: string) => evaluate<string>(browser(), session, `deskTest.screen(${JSON.stringify(pane ?? (await focused()) ?? "")})`);

/** A key as the keyboard sends it: keydown (with its text, if any) and keyup, with CDP's modifier bits. */
async function press(code: string, key: string, keyCode: number, modifiers = 0, text?: string): Promise<void> {
  const base = { code, key, windowsVirtualKeyCode: keyCode, modifiers };
  await browser().send("Input.dispatchKeyEvent", { ...base, type: text === undefined ? "rawKeyDown" : "keyDown", ...(text === undefined ? {} : { text }) }, { sessionId: session });
  await browser().send("Input.dispatchKeyEvent", { ...base, type: "keyUp" }, { sessionId: session });
}

async function typeText(text: string): Promise<void> {
  await browser().send("Input.insertText", { text }, { sessionId: session });
}

async function enter(): Promise<void> {
  await press("Enter", "Enter", 13, 0, "\r");
}

describe("the panel's keys (slice 6b) in the live container", () => {
  beforeAll(async () => {
    installed = await installDesk({ port: PORT, resultTag: "keys" });
    const launch = await installed.desk();
    if (launch.code !== 0) throw new Error(`desk exited ${launch.code}: ${launch.stderr.trim()}`);
    cdp = await Cdp.connect((await browserVersion(PORT)).webSocketDebuggerUrl);
    const target = await waitFor(async () => (await targets(browser())).find((t) => t.url.startsWith(PANEL_URL)), { label: "the Desk panel", timeoutMs: 30_000 });
    session = await attach(browser(), target.targetId);
    await browser().send("Emulation.setFocusEmulationEnabled", { enabled: true }, { sessionId: session });
    await waitFor(() => evaluate<boolean>(browser(), session, "typeof deskTest === 'object' && deskTest.layout() !== null && deskTest.focused() !== null"), {
      label: "a focused pane",
      timeoutMs: 30_000,
    });
    await waitFor(async () => (await screen()).includes("desk-live %"), { label: "a prompt", timeoutMs: 30_000 });
  }, 240_000);

  afterAll(async () => {
    cdp?.close();
    if (installed === undefined) return;
    const logs = join(installed.deskHome, "logs");
    for (const name of await readdir(logs).catch(() => [])) await saveFile(`keys-log-${name}`, await readFile(join(logs, name)));
    await runAnswering(join(installed.home, ".local", "bin", "desk"), ["quit", "--all"], userEnv(installed.home), "y").catch(() => undefined);
  }, 60_000);

  it(
    "text composed with an input method reaches the shell once",
    async () => {
      await typeText("echo ime-");
      await browser().send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 }, { sessionId: session });
      await browser().send("Input.imeSetComposition", { text: "你好", selectionStart: 2, selectionEnd: 2 }, { sessionId: session });
      await typeText("你好");
      await enter();
      const after = await waitFor(async () => {
        const text = await screen();
        return /^ime-你好$/m.test(text) ? text : null;
      }, { label: "the composed text echoed" });
      await saveResult("keys-ime", { screen: after });

      expect(after.match(/ime-你好/g)).toHaveLength(2);
      expect(after).not.toContain("你好你好");
      expect(after).not.toContain("ni");
    },
    60_000,
  );

  it(
    "Option+Left moves the shell's cursor back one word, as ESC b does",
    async () => {
      await typeText("echo word-a word-b");
      await press("ArrowLeft", "ArrowLeft", 37, ALT);
      await typeText("X");
      await enter();

      await waitFor(async () => /^word-a Xword-b$/m.test(await screen()), { label: "the word moved" });
    },
    60_000,
  );

  it(
    "Cmd+D splits the focused pane, and the new pane takes the keyboard",
    async () => {
      const before = await focused();

      await press("KeyD", "d", 68, META);

      const layout = await waitFor(async () => {
        const now = await shown();
        return now?.root !== null && now !== null && "split" in now.root ? now : null;
      }, { label: "a split" });
      await waitFor(async () => (await focused()) !== before && (await focused()) !== null, { label: "the new pane focused" });
      expect(JSON.stringify(layout.root).match(/p_\w{10}/g)).toHaveLength(2);
    },
    60_000,
  );
});
