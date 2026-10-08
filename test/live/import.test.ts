import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn as spawnPty } from "@lydell/node-pty";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cdp, attach, evaluate, targets, waitFor } from "./lib/cdp.ts";
import { browserVersion, startMainChrome, xdotool } from "./lib/chrome.ts";
import { installDesk, runAnswering, userEnv, type InstalledDesk } from "./lib/desk-run.ts";
import { startFixtureServer, type FixtureServer } from "./lib/fixture-server.ts";
import { LIVE_PORTS } from "./lib/ports.ts";
import { saveFile, saveResult } from "./lib/results.ts";

const PORT = LIVE_PORTS.import;

let installed: InstalledDesk | undefined;
let fixture: FixtureServer | undefined;
let main: { pid: number; stop(): Promise<unknown> } | undefined;

function desk(): InstalledDesk {
  if (installed === undefined) throw new Error("Desk did not start (see the beforeAll failure)");
  return installed;
}

/**
 * The operator's click on the main Chrome's Allow dialog, which its remote debugging toggle shows for each new
 * connection: the dialog's focus starts on its safe button, so Tab, then Return.
 */
async function allowInMainChrome(pid: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const [window] = (await xdotool("search", "--onlyvisible", "--pid", String(pid))).split("\n").filter(Boolean);
  if (window !== undefined) await xdotool("windowfocus", "--sync", window);
  await xdotool("key", "--clearmodifiers", "Tab");
  await xdotool("key", "--clearmodifiers", "Return");
}

/** Runs a desk command on a PTY, answering yes to each question, until `until` shows in its output; then `then` runs. */
async function runSayingYes(args: string[], until: RegExp, then: () => Promise<void>, onOutput?: (output: string) => void): Promise<{ code: number; output: string }> {
  const child = spawnPty(join(desk().home, ".local", "bin", "desk"), args, { name: "xterm-256color", cols: 160, rows: 40, cwd: desk().home, env: userEnv(desk().home) });
  let output = "";
  let answered = 0;
  child.onData((data) => {
    output += data;
    const asked = output.split("[y/N]").length - 1;
    for (; answered < asked; answered += 1) child.write("y\r");
    onOutput?.(output);
  });
  const exited = new Promise<number>((resolve) => child.onExit((exit) => resolve(exit.exitCode)));
  await waitFor(() => until.test(output), { label: `${args.join(" ")}: ${String(until)}`, timeoutMs: 90_000 });
  await then();
  return { code: await exited, output: output.replace(/\r/g, "") };
}

describe("desk import (slice 8) in the live container", () => {
  beforeAll(async () => {
    installed = await installDesk({ port: PORT, resultTag: "import" });
    fixture = await startFixtureServer();
    const launch = await installed.desk();
    if (launch.code !== 0) throw new Error(`desk exited ${launch.code}: ${launch.stderr.trim()}`);
  }, 240_000);

  afterAll(async () => {
    await main?.stop().catch(() => undefined);
    await fixture?.close();
    if (installed === undefined) return;
    await saveFile("import-audit.log", await readFile(join(installed.deskHome, "logs", "audit.log")).catch(() => Buffer.from("")));
    await runAnswering(join(installed.home, ".local", "bin", "desk"), ["quit", "--all"], userEnv(installed.home), "y").catch(() => undefined);
  }, 60_000);

  it(
    "cookies from a second Chrome move into Desk and the fixture site sees them",
    async () => {
      const value = `moved-${randomBytes(6).toString("hex")}`;
      const origin = fixture?.origin ?? "";
      main = await startMainChrome({ home: desk().home });
      const portFile = join(desk().home, ".config", "google-chrome", "DevToolsActivePort");
      const [mainPort, mainPath] = (await waitFor(() => readFile(portFile, "utf8").catch(() => null), { label: "the main Chrome's DevToolsActivePort", timeoutMs: 30_000 })).split("\n");
      const mainPid = main.pid;
      // The main Chrome holds the cookie, as a site's login would leave it (set over this test's own allowed connection).
      const allowed = allowInMainChrome(mainPid);
      const mainCdp = await Cdp.connect(`ws://127.0.0.1:${mainPort}${mainPath}`, 20_000);
      await allowed;
      await mainCdp.send("Storage.setCookies", { cookies: [{ url: `${origin}/`, name: "desk-import", value, expires: Math.floor(Date.now() / 1000) + 3600 }] });
      mainCdp.close();

      let clicked = false;
      const run = await runSayingYes(
        ["import", "cookies", "--domains", "127.0.0.1"],
        /Moved \d+ cookies? into Desk/,
        async () => {
          // The end waits for the main Chrome's remote debugging to be off: quitting it closes the port.
          await main?.stop();
          main = undefined;
        },
        (output) => {
          // The import connects once the instructions are out: the operator allows it.
          if (!clicked && output.includes("An Allow dialog will appear")) {
            clicked = true;
            void allowInMainChrome(mainPid);
          }
        },
      );

      const deskCdp = await Cdp.connect((await browserVersion(PORT)).webSocketDebuggerUrl);
      const deskTab = await deskCdp.send<{ targetId: string }>("Target.createTarget", { url: `${origin}/` });
      const deskPage = await attach(deskCdp, deskTab.targetId);
      await waitFor(() => evaluate<boolean>(deskCdp, deskPage, "document.readyState === 'complete'"), { label: "the Desk page" });
      const seen = await evaluate<string>(deskCdp, deskPage, "document.cookie");
      deskCdp.close();
      const audit = await readFile(join(desk().deskHome, "logs", "audit.log"), "utf8").catch(() => "");
      await saveResult("import-cookies", { code: run.code, output: run.output.replaceAll(value, "<value>"), seen: seen.includes(value), audit });

      expect(run.code).toBe(0);
      expect(seen).toContain(`desk-import=${value}`);
      expect(run.output).not.toContain(value);
      expect(audit).not.toContain(value);
      expect(audit).toContain('"op":"import-cookies"');
    },
    240_000,
  );
});
