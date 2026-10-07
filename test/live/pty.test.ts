import { execFile } from "node:child_process";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { spawn, type IPty } from "@lydell/node-pty";
import { afterEach, describe, expect, it } from "vitest";
import { shellEnv } from "../../packages/core/src/index.ts";
import { waitFor } from "./lib/cdp.ts";
import { saveResult } from "./lib/results.ts";

const run = promisify(execFile);
const ZSH = "/usr/bin/zsh";
const TMUX = "/usr/bin/tmux";
const ZSH_FIXTURES = fileURLToPath(new URL("./fixtures/zsh", import.meta.url));

/** tmux client commands from the test itself: an explicit environment and a timeout; the socket is always explicit. */
function tmux(...args: string[]): Promise<{ stdout: string }> {
  return run(TMUX, args, { env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", TMPDIR: tmpdir() }, signal: AbortSignal.timeout(5_000) });
}

/** A shell on a PTY, with everything it printed so far. */
type Pane = {
  pty: IPty;
  output: () => string;
  exited: Promise<{ exitCode: number; signal?: number }>;
  /** Once it has exited its pid may be reused, so it is never signalled again. */
  running: () => boolean;
};

const panes: Pane[] = [];
const tmuxSockets: string[] = [];

/** A fresh HOME holding the zsh fixtures, which mark that a login (.zprofile) and an interactive (.zshrc) shell ran. */
async function fixtureHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "pty-home-"));
  await copyFile(join(ZSH_FIXTURES, "zprofile"), join(home, ".zprofile"));
  await copyFile(join(ZSH_FIXTURES, "zshrc"), join(home, ".zshrc"));
  return home;
}

/** Starts `zsh -l` on a PTY the way Desk's daemon will: core's pane environment, the panel's size. */
async function openPane(cols: number, rows: number): Promise<Pane> {
  const home = await fixtureHome();
  const env = shellEnv({
    parent: { HOME: home, USER: "lab", LOGNAME: "lab", SHELL: ZSH, TMPDIR: tmpdir(), LANG: "C.UTF-8" },
    version: "0.0.0-live",
    agent: null,
  });
  const pty = spawn(ZSH, ["-l"], { name: "xterm-256color", cols, rows, cwd: home, env });
  let output = "";
  pty.onData((data) => {
    output += data;
  });
  let running = true;
  const exited = new Promise<{ exitCode: number; signal?: number }>((resolve) =>
    pty.onExit((exit) => {
      running = false;
      resolve(exit);
    }),
  );
  const pane = { pty, output: () => output, exited, running: () => running };
  panes.push(pane);
  await waitFor(() => output.includes("desk-live %"), { label: "the zsh prompt" });
  return pane;
}

/**
 * Types a command whose answer is marked `<tag> … END` and reads only what the shell printed after it. The tag is split
 * in the command, so the echoed command line never matches.
 */
async function ask(pane: Pane, tag: string, body: string): Promise<string> {
  const pattern = new RegExp(`${tag} (.*?) END`);
  const from = pane.output().length;
  pane.pty.write(`print -r -- "${tag.slice(0, 2)}""${tag.slice(2)} ${body} END"\r`);
  const match = await waitFor(() => pattern.exec(pane.output().slice(from)), { label: `the ${tag} answer` });
  return match[1] ?? "";
}

afterEach(async () => {
  // Only processes this file spawned and that still run: its PTY shells, and the tmux servers on its own sockets (a test
  // that failed early may not have started one, so kill-server may find nothing).
  for (const pane of panes.splice(0)) {
    if (pane.running()) pane.pty.kill("SIGKILL");
    await pane.exited;
  }
  for (const socket of tmuxSockets.splice(0)) {
    await tmux("-S", socket, "kill-server").catch(() => undefined);
  }
});

describe("the PTY package in the live container", () => {
  it("the PTY package starts a login, interactive zsh on a real tty and resizes it", async () => {
    const pane = await openPane(100, 30);
    const probe = Object.fromEntries(
      (
        await ask(
          pane,
          "PROBE",
          "login=${options[login]} interactive=${options[interactive]} zprofile=${ZPROFILE_RAN:-0} zshrc=${ZSHRC_RAN:-0} " +
            "tty=$(tty) stdin=$([[ -t 0 ]] && echo y || echo n) stderr=$([[ -t 2 ]] && echo y || echo n) size=$(stty size | tr ' ' x)",
        )
      )
        .split(" ")
        .map((pair) => pair.split("=")),
    );
    pane.pty.resize(132, 43);
    const resized = await waitFor(async () => {
      const size = await ask(pane, "SIZE", "$(stty size | tr ' ' x)");
      return size === "43x132" ? size : null;
    }, { label: "the new size" });
    await saveResult("pty-zsh", { probe, resized });

    expect(probe).toEqual({
      login: "on",
      interactive: "on",
      zprofile: "1",
      zshrc: "1",
      tty: expect.stringMatching(/^\/dev\/pts\/\d+$/),
      stdin: "y",
      stderr: "y",
      size: "30x100",
    });
    expect(resized).toBe("43x132");
  });

  it("a tmux session survives SIGKILL of the PTY attached to it", async () => {
    const socket = join(await mkdtemp(join(tmpdir(), "tmux-")), "tmux.sock");
    tmuxSockets.push(socket);
    const pane = await openPane(100, 30);
    pane.pty.write(`${TMUX} -S ${socket} new-session -d -s keep -x 100 -y 30 && ${TMUX} -S ${socket} attach -t keep\r`);
    await waitFor(() => /\[keep\]/.test(pane.output()), { label: "the tmux status line" });
    pane.pty.write("echo inside-$((6 * 7))\r");
    await waitFor(() => pane.output().includes("inside-42"), { label: "output inside tmux" });

    pane.pty.kill("SIGKILL");
    const exit = await pane.exited;
    const alive = await tmux("-S", socket, "has-session", "-t", "=keep").then(
      () => true,
      () => false,
    );
    // `=keep:` is the exact session's current pane; a bare `=keep` names a session, which capture-pane does not take.
    const screen = alive
      ? (await tmux("-S", socket, "capture-pane", "-p", "-t", "=keep:")).stdout
      : "";
    await saveResult("pty-tmux-survives", { ptyExit: exit, sessionAlive: alive });

    expect(exit.signal).toBe(9);
    expect(alive).toBe(true);
    expect(screen).toContain("inside-42");
  });
});
