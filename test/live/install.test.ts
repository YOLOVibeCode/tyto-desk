import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESK_EXTENSION_ID, DESK_SKILL } from "../../packages/core/src/index.ts";
import { Cdp, attach, evaluate, targets, waitFor } from "./lib/cdp.ts";
import { browserVersion } from "./lib/chrome.ts";
import { installDesk, runAnswering, userEnv, type InstalledDesk } from "./lib/desk-run.ts";
import { LIVE_PORTS } from "./lib/ports.ts";
import { saveFile, saveResult } from "./lib/results.ts";

const PORT = LIVE_PORTS.install;
const PANEL_URL = `chrome-extension://${DESK_EXTENSION_ID}/panel.html`;

let installed: InstalledDesk | undefined;

function desk(): InstalledDesk {
  if (installed === undefined) throw new Error("Desk did not install (see the beforeAll failure)");
  return installed;
}

/** The panel's pane, with a session to read and type into it, once its shell shows a prompt. */
async function panel(): Promise<{ cdp: Cdp; session: string; pane: string }> {
  const cdp = await Cdp.connect((await browserVersion(PORT)).webSocketDebuggerUrl);
  const target = await waitFor(async () => (await targets(cdp)).find((t) => t.url.startsWith(PANEL_URL)), { label: "the Desk panel", timeoutMs: 30_000 });
  const session = await attach(cdp, target.targetId);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, { sessionId: session });
  const pane = await waitFor(() => evaluate<string | null>(cdp, session, "typeof deskTest === 'object' && deskTest.panes().length > 0 ? deskTest.panes()[0] : null"), {
    label: "the panel's pane",
  });
  await waitFor(async () => (await evaluate<string>(cdp, session, `deskTest.screen(${JSON.stringify(pane)})`)).includes("desk-live %"), { label: "a prompt", timeoutMs: 30_000 });
  return { cdp, session, pane };
}

/** The shell's pid, from `echo <tag>-$$` typed into the pane. */
async function shellPid(p: { cdp: Cdp; session: string; pane: string }, tag: string): Promise<string> {
  await evaluate(p.cdp, p.session, "document.querySelector('textarea.xterm-helper-textarea')?.focus(), true");
  await p.cdp.send("Input.insertText", { text: `echo ${tag}-$$` }, { sessionId: p.session });
  for (const type of ["keyDown", "keyUp"]) {
    await p.cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) }, { sessionId: p.session });
  }
  return waitFor(async () => new RegExp(`^${tag}-(\\d+)$`, "m").exec(await evaluate<string>(p.cdp, p.session, `deskTest.screen(${JSON.stringify(p.pane)})`))?.[1] ?? null, {
    label: `the shell's pid (${tag})`,
  });
}

describe("install (slice 5) in the live container", () => {
  beforeAll(async () => {
    installed = await installDesk({ port: PORT, resultTag: "install" });
  }, 240_000);

  afterAll(async () => {
    if (installed === undefined) return;
    const logs = join(installed.deskHome, "logs");
    for (const name of await readdir(logs).catch(() => [])) await saveFile(`install-log-${name}`, await readFile(join(logs, name)));
    await runAnswering(join(installed.home, ".local", "bin", "desk"), ["quit", "--all"], userEnv(installed.home), "y").catch(() => undefined);
  }, 60_000);

  it(
    "a fresh HOME goes from desk install to a working panel with one desk",
    async () => {
      const launch = await desk().desk();
      const p = await panel();
      const pid = await shellPid(p, "fresh");
      p.cdp.close();
      const skill = await readFile(join(desk().home, ".claude", "skills", "desk", "SKILL.md"), "utf8").catch(() => null);
      const recorded = JSON.parse(await readFile(join(desk().deskHome, "installed.json"), "utf8")) as { files: { kind: string }[] };
      await saveResult("install-fresh", { launch, pid, skill: skill === DESK_SKILL, files: recorded.files.map((file) => file.kind) });

      expect(launch.code).toBe(0);
      expect(Number(pid)).toBeGreaterThan(1);
      expect(skill).toBe(DESK_SKILL);
      expect(recorded.files.map((file) => file.kind)).toContain("skill");
    },
    180_000,
  );

  it(
    "installing a newer version while panes run keeps every pane attached with the same shell pid",
    async () => {
      const before = await panel();
      const pid = await shellPid(before, "before-update");
      before.cdp.close();

      const update = await desk().installVersion("0.0.2-dev.live+0000000");
      const launch = await desk().desk();
      await saveResult("install-update-launch", { update, launch });
      const after = await panel();
      const again = await shellPid(after, "after-update");
      after.cdp.close();
      const current = await desk().desk(["--version"]);
      await saveResult("install-update", { update: { code: update.code }, launch, pid, again, current: current.stdout.trim() });

      expect(update.code).toBe(0);
      expect(launch.code).toBe(0);
      expect(current.stdout).toContain("0.0.2-dev.live+0000000");
      expect(after.pane).toBe(before.pane);
      expect(again).toBe(pid);
    },
    300_000,
  );
});
