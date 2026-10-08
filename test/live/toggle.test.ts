import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESK_EXTENSION_ID } from "../../packages/core/src/index.ts";
import { Cdp, attach, evaluate, targets, waitFor, type TargetInfo } from "./lib/cdp.ts";
import { browserVersion } from "./lib/chrome.ts";
import { installDesk, runAnswering, userEnv, type InstalledDesk } from "./lib/desk-run.ts";
import { LIVE_PORTS } from "./lib/ports.ts";
import { saveFile, saveResult } from "./lib/results.ts";

const PORT = LIVE_PORTS.toggle;
const PANEL_URL = `chrome-extension://${DESK_EXTENSION_ID}/panel.html`;
const WORKER_URL = `chrome-extension://${DESK_EXTENSION_ID}/sw.js`;

let installed: InstalledDesk | undefined;

function desk(): InstalledDesk {
  if (installed === undefined) throw new Error("Desk did not start (see the beforeAll failure)");
  return installed;
}

async function browser(): Promise<Cdp> {
  return Cdp.connect((await browserVersion(PORT)).webSocketDebuggerUrl);
}

/** The toggle command's shortcut as Chrome has it bound now. */
async function boundShortcut(): Promise<string> {
  const cdp = await browser();
  try {
    const worker = await waitFor(async () => (await targets(cdp)).find((t) => t.url === WORKER_URL), { label: "the worker", timeoutMs: 30_000 });
    const session = await attach(cdp, worker.targetId);
    return await evaluate<string>(cdp, session, "chrome.commands.getAll().then((all) => all.find((c) => c.name === 'toggle-terminal')?.shortcut ?? '')");
  } finally {
    cdp.close();
  }
}

async function relaunch(): Promise<void> {
  const quit = await desk().desk(["quit"]);
  if (quit.code !== 0) throw new Error(`desk quit exited ${quit.code}`);
  const launch = await desk().desk();
  if (launch.code !== 0) throw new Error(`desk exited ${launch.code}: ${launch.stderr.trim()}`);
}

describe("the toggle (slice 6c) in the live container", () => {
  beforeAll(async () => {
    installed = await installDesk({ port: PORT, resultTag: "toggle" });
    const launch = await installed.desk();
    if (launch.code !== 0) throw new Error(`desk exited ${launch.code}: ${launch.stderr.trim()}`);
  }, 240_000);

  afterAll(async () => {
    if (installed === undefined) return;
    const logs = join(installed.deskHome, "logs");
    for (const name of await readdir(logs).catch(() => [])) await saveFile(`toggle-log-${name}`, await readFile(join(logs, name)));
    await runAnswering(join(installed.home, ".local", "bin", "desk"), ["quit", "--all"], userEnv(installed.home), "y").catch(() => undefined);
  }, 60_000);

  it(
    "rebinding the toggle key survives a Chrome restart",
    async () => {
      const before = await boundShortcut();
      const set = await desk().desk(["config", "toggle-key", "Ctrl+Shift+K"]);
      // desk renders the new key into the manifest and loads the extension again.
      const apply = await desk().desk();
      const applied = await boundShortcut();
      await relaunch();
      const afterRestart = await boundShortcut();
      await saveResult("toggle-rebind", { before, set, apply, applied, afterRestart });

      expect(set.code).toBe(0);
      expect(applied).toBe("Ctrl+Shift+K");
      expect(afterRestart).toBe("Ctrl+Shift+K");
    },
    240_000,
  );

  // §10 and slice 6's list: "the toggle shortcut sent as a key event on a tab target hides and shows the panel", unless
  // Chrome on Linux does not route synthetic keys to extension commands. It does not (D118): a key event sent with CDP
  // reaches the page, never the command, even with the shortcut bound. This records it, and fails the day Chrome routes
  // them, so the sentence above can come back; until then the toggle rests on its unit tests and on M6, never on a
  // service-worker evaluate.
  it(
    "Chrome on Linux hands a synthetic key event on a tab target to the page, never to the toggle command",
    async () => {
      const cdp = await browser();
      try {
        expect(await boundShortcut()).toBe("Ctrl+Shift+K");
        const tab = await waitFor(async () => (await targets(cdp)).find((t: TargetInfo) => t.type === "page" && !t.url.startsWith("chrome-extension://")), {
          label: "a tab",
        });
        const session = await attach(cdp, tab.targetId);
        await cdp.send("Page.bringToFront", {}, { sessionId: session });
        const worker = await attach(cdp, (await waitFor(async () => (await targets(cdp)).find((t) => t.url === WORKER_URL), { label: "the worker" })).targetId);
        await evaluate(cdp, worker, "globalThis.deskCommands = 0; chrome.commands.onCommand.addListener(() => { globalThis.deskCommands += 1; }), true");
        await evaluate(cdp, session, "globalThis.deskKeys = 0; addEventListener('keydown', () => { globalThis.deskKeys += 1; }, true), true");

        // The bound shortcut: CDP's modifier bits 2 (Ctrl) and 8 (Shift).
        for (const type of ["rawKeyDown", "keyUp"]) {
          await cdp.send("Input.dispatchKeyEvent", { type, key: "K", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 2 | 8 }, { sessionId: session });
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const seen = { page: await evaluate<number>(cdp, session, "globalThis.deskKeys"), command: await evaluate<number>(cdp, worker, "globalThis.deskCommands") };
        await saveResult("toggle-key-event", seen);

        expect(seen).toEqual({ page: 1, command: 0 });
      } finally {
        cdp.close();
      }
    },
    120_000,
  );
});
