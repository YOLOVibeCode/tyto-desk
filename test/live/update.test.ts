import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESK_EXTENSION_ID } from "../../packages/core/src/index.ts";
import { Cdp, attach, evaluate, targets, waitFor } from "./lib/cdp.ts";
import { browserVersion } from "./lib/chrome.ts";
import { installDesk, packVersion, runAnswering, userEnv, type InstalledDesk } from "./lib/desk-run.ts";
import { LIVE_PORTS } from "./lib/ports.ts";
import { saveResult } from "./lib/results.ts";

const PORT = LIVE_PORTS.update;
const PANEL_URL = `chrome-extension://${DESK_EXTENSION_ID}/panel.html`;
const REPO = "YOLOVibeCode/tyto-desk";
const RELEASE = "0.0.3";
const COMMIT = "3".repeat(40);

let installed: InstalledDesk | undefined;
let server: Server | undefined;
let api = "";
let ghDir = "";

function desk(): InstalledDesk {
  if (installed === undefined) throw new Error("Desk did not install (see the beforeAll failure)");
  return installed;
}

async function panel(): Promise<{ cdp: Cdp; session: string; pane: string }> {
  const cdp = await Cdp.connect((await browserVersion(PORT)).webSocketDebuggerUrl);
  const target = await waitFor(async () => (await targets(cdp)).find((t) => t.url.startsWith(PANEL_URL)), { label: "the Desk panel", timeoutMs: 30_000 });
  const session = await attach(cdp, target.targetId);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, { sessionId: session });
  const pane = await waitFor(() => evaluate<string | null>(cdp, session, "typeof deskTest === 'object' && deskTest.panes().length > 0 ? deskTest.panes()[0] : null"), { label: "the pane" });
  await waitFor(async () => (await evaluate<string>(cdp, session, `deskTest.screen(${JSON.stringify(pane)})`)).includes("desk-live %"), { label: "a prompt", timeoutMs: 30_000 });
  return { cdp, session, pane };
}

async function shellPid(tag: string): Promise<string> {
  const p = await panel();
  try {
    await evaluate(p.cdp, p.session, "document.querySelector('textarea.xterm-helper-textarea')?.focus(), true");
    await p.cdp.send("Input.insertText", { text: `echo ${tag}-$$` }, { sessionId: p.session });
    for (const type of ["keyDown", "keyUp"]) {
      await p.cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) }, { sessionId: p.session });
    }
    return await waitFor(async () => new RegExp(`^${tag}-(\\d+)$`, "m").exec(await evaluate<string>(p.cdp, p.session, `deskTest.screen(${JSON.stringify(p.pane)})`))?.[1] ?? null, {
      label: `the shell's pid (${tag})`,
    });
  } finally {
    p.cdp.close();
  }
}

/** The installed desk with the stub gh (DESK_GH: desk never takes gh from PATH), the fixture's API, and a linux pack allowed. */
function updateEnv(): NodeJS.ProcessEnv {
  return { ...userEnv(desk().home), DESK_GH: join(ghDir, "gh"), DESK_IN_CONTAINER: "1", DESK_RELEASE_API: api };
}

describe("desk update (slice D2) in the live container", () => {
  beforeAll(async () => {
    installed = await installDesk({ port: PORT, resultTag: "update" });
    // The release: a stable pack of this checkout, its tarball and SHA256SUMS, served as GitHub serves them.
    const release = await packVersion(RELEASE, "update-release", { channel: "stable", commit: COMMIT, tarball: true });
    if (release.tarball === null) throw new Error("no tarball");
    const tarball = await readFile(release.tarball);
    const name = basename(release.tarball);
    const sums = `${createHash("sha256").update(tarball).digest("hex")}  ${name}\n`;
    server = createServer((req, res) => {
      const json = (body: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const base = `/repos/${REPO}`;
      const assets = [
        { name, browser_download_url: `${api}/download/${name}` },
        { name: "SHA256SUMS", browser_download_url: `${api}/download/SHA256SUMS` },
      ];
      if (req.url === `${base}/releases/latest` || req.url === `${base}/releases/tags/v${RELEASE}`) return json({ tag_name: `v${RELEASE}`, assets });
      if (req.url === `${base}/git/ref/tags/v${RELEASE}`) return json({ object: { type: "commit", sha: COMMIT } });
      if (req.url === `${base}/branches/main`) return json({ commit: { sha: COMMIT } });
      if (req.url === `/download/${name}`) return res.end(tarball);
      if (req.url === "/download/SHA256SUMS") return res.end(sums);
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // A gh that is new enough, signed in, and vouches for the release (the fixture stands in for GitHub's attestations).
    ghDir = await mkdtemp(join(tmpdir(), "stub-gh-"));
    await mkdir(ghDir, { recursive: true });
    await writeFile(
      join(ghDir, "gh"),
      ['#!/bin/sh', 'case "$1" in', '  --version) echo "gh version 2.102.0 (2026-01-01)" ;;', '  auth|release|attestation) exit 0 ;;', '  *) exit 1 ;;', "esac", ""].join("\n"),
    );
    await chmod(join(ghDir, "gh"), 0o755);
    const launch = await installed.desk();
    if (launch.code !== 0) throw new Error(`desk exited ${launch.code}: ${launch.stderr.trim()}`);
  }, 300_000);

  afterAll(async () => {
    await new Promise((resolve) => (server === undefined ? resolve(null) : server.close(resolve)));
    if (installed === undefined) return;
    await runAnswering(join(installed.home, ".local", "bin", "desk"), ["quit", "--all"], userEnv(installed.home), "y").catch(() => undefined);
  }, 60_000);

  it(
    "desk update from a fake release feed while panes run keeps every pane attached with the same shell pid, and so does desk rollback",
    async () => {
      const launcher = join(desk().home, ".local", "bin", "desk");
      const before = await shellPid("before-update");

      const updated = await runAnswering(launcher, ["update", "--channel", "stable"], updateEnv(), "y");
      const relaunch = await desk().desk();
      await saveResult("update-step", { before, updated, relaunch });
      const afterUpdate = await shellPid("after-update");
      const versionAfter = (await desk().desk(["--version"])).stdout.trim();

      const rolledBack = await runAnswering(launcher, ["rollback"], updateEnv(), "y");
      const again = await desk().desk();
      const afterRollback = await shellPid("after-rollback");
      const versionBack = (await desk().desk(["--version"])).stdout.trim();
      await saveResult("update-run", { updated, relaunch, rolledBack, again, before, afterUpdate, afterRollback, versionAfter, versionBack });

      expect(updated.code).toBe(0);
      expect(versionAfter).toContain(RELEASE);
      expect(afterUpdate).toBe(before);
      expect(rolledBack.code).toBe(0);
      expect(versionBack).toContain("0.0.1-dev.live");
      expect(afterRollback).toBe(before);
    },
    300_000,
  );
});
