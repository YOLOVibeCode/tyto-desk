import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
const PORT = LIVE_PORTS.agents;
const PANEL_URL = `chrome-extension://${DESK_EXTENSION_ID}/panel.html`;

type Panel = { cdp: Cdp; session: string; pane: string };

let installed: InstalledDesk | undefined;
let fixture: FixtureServer | undefined;
let panel: Panel | undefined;

function setup(): { installed: InstalledDesk; fixture: FixtureServer; panel: Panel } {
  if (installed === undefined || fixture === undefined || panel === undefined) throw new Error("Desk did not start (see the beforeAll failure)");
  return { installed, fixture, panel };
}

const screen = (p: Panel) => evaluate<string>(p.cdp, p.session, `deskTest.screen(${JSON.stringify(p.pane)})`);

/** Types a command line into the pane, followed by `echo <tag>-$?`, and returns its output and exit code. */
async function inPane(p: Panel, command: string, tag: string, timeoutMs = 30_000): Promise<{ output: string; exit: number }> {
  const before = (await screen(p)).length;
  await evaluate(p.cdp, p.session, "document.querySelector('textarea.xterm-helper-textarea')?.focus(), true");
  await p.cdp.send("Input.insertText", { text: `${command}; echo ${tag}-$?` }, { sessionId: p.session });
  for (const type of ["keyDown", "keyUp"]) {
    await p.cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) }, { sessionId: p.session });
  }
  const done = await waitFor(
    async () => {
      const text = (await screen(p)).slice(Math.max(0, before - 200));
      const match = new RegExp(`^${tag}-(\\d+)$`, "m").exec(text);
      return match === null ? null : { output: text, exit: Number(match[1]) };
    },
    { label: tag, timeoutMs },
  );
  return done;
}

/** A directory's regular files, recursively, with each one's sha256 (agent-browser's sockets are not files). */
async function snapshotDir(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) for (const [name, hash] of Object.entries(await snapshotDir(path))) out[`${entry.name}/${name}`] = hash;
    else if (entry.isFile()) out[entry.name] = createHash("sha256").update(await readFile(path)).digest("hex");
  }
  return out;
}

describe("agent controls (slice 4c) in the live container", () => {
  beforeAll(async () => {
    installed = await installDesk({ port: PORT, resultTag: "agents" });
    fixture = await startFixtureServer();
    // Your own agent-browser files, with a restore key: Desk must never touch them.
    const own = join(installed.home, ".agent-browser");
    await mkdir(join(own, "sessions"), { recursive: true });
    await writeFile(join(own, "config.json"), `${JSON.stringify({ restore: "main", headed: false })}\n`);
    await writeFile(join(own, "sessions", "main-default.json"), `${JSON.stringify({ cookies: [{ name: "fixture", value: "keep-me" }] })}\n`);
    const launch = await installed.desk();
    if (launch.code !== 0) throw new Error(`desk exited ${launch.code}: ${launch.stderr.trim()}`);
    // desk starts desk watch, which serves the guarded endpoint agents use, as it returns.
    await waitFor(() => browserVersion(PORT + 1).then(() => true, () => null), { label: "the guarded endpoint", timeoutMs: 20_000 });
    const cdp = await Cdp.connect((await browserVersion(PORT)).webSocketDebuggerUrl);
    const target = await waitFor(async () => (await targets(cdp)).find((t) => t.url.startsWith(PANEL_URL)), { label: "the Desk panel" });
    const session = await attach(cdp, target.targetId);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, { sessionId: session });
    const pane = await waitFor(() => evaluate<string | null>(cdp, session, "typeof deskTest === 'object' && deskTest.panes().length > 0 ? deskTest.panes()[0] : null"), {
      label: "the panel's pane",
    });
    panel = { cdp, session, pane };
    await waitFor(async () => (await screen(panel as Panel)).includes("desk-live %"), { label: "a prompt", timeoutMs: 30_000 });
  }, 240_000);

  afterAll(async () => {
    panel?.cdp.close();
    await fixture?.close();
    if (installed === undefined) return;
    await runAnswering(join(installed.home, ".local", "bin", "desk"), ["quit", "--all"], userEnv(installed.home), "y").catch(() => undefined);
  }, 60_000);

  it(
    "desk agents pause makes the next agent-browser command from a Desk pane fail with a policy denial",
    async () => {
      const { installed: desk, fixture: server, panel: p } = setup();
      const working = await inPane(p, `agent-browser open ${server.origin}/page1.html`, "opened");

      const paused = await desk.desk(["agents", "pause"]);
      const banner = await waitFor(async () => {
        const text = await evaluate<string>(p.cdp, p.session, "deskTest.banner()");
        return text.includes("paused") ? text : null;
      }, { label: "the paused notice" });
      const denied = await inPane(p, "agent-browser snapshot -i", "denied");
      const resumed = await runAnswering(join(desk.home, ".local", "bin", "desk"), ["agents", "resume"], userEnv(desk.home), "y");
      const again = await inPane(p, "agent-browser snapshot -i", "again");
      await saveResult("agents-pause", { working, paused, banner, denied: denied.output.slice(-600), resumed, again: again.exit });

      expect(working.exit).toBe(0);
      expect(paused.code).toBe(0);
      expect(denied.exit).not.toBe(0);
      expect(denied.output.toLowerCase()).toMatch(/polic|denied|not allowed/);
      expect(resumed.code).toBe(0);
      expect(again.exit).toBe(0);
    },
    180_000,
  );

  it(
    "~/.agent-browser/config.json and sessions/ are byte-identical after the run, including desk agents detach from a shell with a seeded restore key",
    async () => {
      const { installed: desk, fixture: server, panel: p } = setup();
      const own = join(desk.home, ".agent-browser");
      const before = { config: createHash("sha256").update(await readFile(join(own, "config.json"))).digest("hex"), sessions: await snapshotDir(join(own, "sessions")) };
      await inPane(p, `agent-browser open ${server.origin}/page2.html`, "opened-2");
      const listed = await desk.desk(["agents"]);

      // A shell outside Desk, with your restore key in its environment as well as in your config.
      const detach = await desk.desk(["agents", "detach"]);
      // A closed session's daemon exits a moment after close returns.
      const left = await waitFor(
        async () => {
          const listed = await desk.desk(["agents"]);
          return listed.stdout.includes("No Desk agent sessions") ? listed : null;
        },
        { label: "no Desk agent session left", timeoutMs: 15_000 },
      ).catch(async () => desk.desk(["agents"]));
      const after = { config: createHash("sha256").update(await readFile(join(own, "config.json"))).digest("hex"), sessions: await snapshotDir(join(own, "sessions")) };
      await saveResult("agents-files", { before, after, listed: listed.stdout, detach, left: left.stdout });

      expect(listed.stdout).toMatch(/^desk-/m);
      expect(detach.code).toBe(0);
      expect(left.stdout.trim()).toBe("No Desk agent sessions are running");
      expect(after).toEqual(before);
    },
    180_000,
  );

  it(
    "a tmux session created from a pane sees the Desk variables and one created outside Desk does not",
    async () => {
      const { installed: desk, panel: p } = setup();
      const inside = await inPane(p, "tmux new-session -d -s desk-live-inside && tmux show-environment -t desk-live-inside DESK_PANE", "inside");
      const env = { HOME: desk.home, PATH: "/usr/bin:/bin", USER: "lab", LANG: "C.UTF-8" };
      await run("tmux", ["new-session", "-d", "-s", "desk-live-outside"], { env });
      const outside = await run("tmux", ["show-environment", "-t", "desk-live-outside", "DESK_PANE"], { env }).then(
        (out) => out.stdout.trim(),
        (err: { stdout?: string; stderr?: string }) => `${err.stdout ?? ""}${err.stderr ?? ""}`.trim(),
      );
      for (const name of ["desk-live-inside", "desk-live-outside"]) await run("tmux", ["kill-session", "-t", name], { env }).catch(() => undefined);
      await saveResult("agents-tmux", { inside: inside.output.slice(-300), outside });

      expect(inside.output).toContain(`DESK_PANE=${p.pane}`);
      expect(outside).not.toContain("DESK_PANE=");
    },
    120_000,
  );
});
