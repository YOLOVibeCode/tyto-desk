import { describe, expect, it } from "vitest";
import { PaneKeeper, type PanesFile } from "../src/index.ts";
import { FakeClock, FakeProcessCwd, FakeShellProbe, FakeTmuxSessions, MemoryPaneStore } from "../src/testing/index.ts";

const P1 = "p_k2m9q3x7ab";
const P2 = "p_m9x1d4f6hz";
const PID = 4242;
const TTY = "/dev/ttys004";

function setup(saved: PanesFile | null = null) {
  const store = new MemoryPaneStore({ panes: saved, recovered: false });
  const cwds = new FakeProcessCwd();
  const probe = new FakeShellProbe();
  const sessions = new FakeTmuxSessions();
  const clock = new FakeClock();
  const keeper = new PaneKeeper({ store, cwds, probe, sessions, clock });
  return { store, cwds, probe, sessions, clock, keeper };
}

/** Lets the keeper's pending promises run, and the clock pass `ms`. */
async function pass(clock: FakeClock, ms: number): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await clock.advance(ms);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe("what a pane leaves for its cold restore (docs/IMPLEMENTATION.md §7.4)", () => {
  it("panes.json holds the cwd, tmux names and shell, and never a title, output or input", async () => {
    const { store, cwds, keeper, clock } = setup();
    await keeper.load();
    cwds.cwds.set(PID, "/Users/alex/Dev/tyto-desk");

    keeper.started(P1, PID, "/bin/zsh");
    keeper.entered(P1);
    await pass(clock, 3_000);

    expect(store.last()).toEqual({ version: 1, panes: { [P1]: { cwd: "/Users/alex/Dev/tyto-desk", tmux: null, lastTmux: null, shell: "/bin/zsh" } } });
  });

  it("the cwd is refreshed about 1 s after a command is entered", async () => {
    const { store, cwds, keeper, clock } = setup();
    await keeper.load();
    cwds.cwds.set(PID, "/Users/alex");
    keeper.started(P1, PID, "/bin/zsh");
    await pass(clock, 3_000);

    cwds.cwds.set(PID, "/Users/alex/Dev");
    keeper.entered(P1);
    await pass(clock, 900);
    // Read from the keeper itself: panes.json's own 1 s debounce would hide when the directory was read.
    const early = keeper.record(P1)?.cwd;
    await pass(clock, 2_000);

    expect(early).toBe("/Users/alex");
    expect(store.last().panes[P1]?.cwd).toBe("/Users/alex/Dev");
  });

  it("a cd is in panes.json about 1 s after it was entered, so a daemon killed 2 s later brings the pane back there", async () => {
    const { store, cwds, keeper, clock } = setup();
    await keeper.load();
    cwds.cwds.set(PID, "/Users/alex");
    keeper.started(P1, PID, "/bin/zsh");
    await pass(clock, 5_000);

    cwds.cwds.set(PID, "/Users/alex/Dev/new");
    keeper.entered(P1);
    await pass(clock, 1_200);

    expect(store.last().panes[P1]?.cwd).toBe("/Users/alex/Dev/new");
  });

  it("changes within a second of a save are written together, a second later", async () => {
    const { store, cwds, keeper, clock } = setup();
    await keeper.load();
    cwds.cwds.set(PID, "/a");
    keeper.started(P1, PID, "/bin/zsh");
    await pass(clock, 5_000);
    const before = store.saved.length;

    cwds.cwds.set(PID, "/b");
    await keeper.refresh(P1);
    cwds.cwds.set(PID, "/c");
    await keeper.refresh(P1);
    await pass(clock, 1_500);

    expect(store.saved.slice(before).map((saved) => saved.panes[P1]?.cwd)).toEqual(["/b", "/c"]);
  });

  it("the cwd is refreshed every 30 s while the shell runs", async () => {
    const { store, cwds, keeper, clock } = setup();
    await keeper.load();
    cwds.cwds.set(PID, "/Users/alex");
    keeper.started(P1, PID, "/bin/zsh");
    await pass(clock, 3_000);

    cwds.cwds.set(PID, "/tmp/project");
    await pass(clock, 31_000);
    await pass(clock, 2_000);

    expect(store.last().panes[P1]?.cwd).toBe("/tmp/project");
  });

  it("a pane's tmux session is found by matching its tty in tmux list-clients", async () => {
    const { store, cwds, probe, sessions, keeper, clock } = setup();
    await keeper.load();
    cwds.cwds.set(PID, "/Users/alex");
    probe.ttys.set(PID, TTY);
    sessions.clientList = [
      { tty: "/dev/ttys009", session: "elsewhere" },
      { tty: TTY, session: "work" },
    ];

    keeper.started(P1, PID, "/bin/zsh");
    keeper.entered(P1);
    await pass(clock, 3_000);

    expect(store.last().panes[P1]).toMatchObject({ tmux: "work", lastTmux: "work" });
  });

  it("lastTmux changes only on an explicit close or an attach to another session", async () => {
    const { store, cwds, probe, sessions, keeper, clock } = setup();
    await keeper.load();
    cwds.cwds.set(PID, "/Users/alex");
    probe.ttys.set(PID, TTY);
    sessions.clientList = [{ tty: TTY, session: "work" }];
    keeper.started(P1, PID, "/bin/zsh");
    keeper.entered(P1);
    await pass(clock, 3_000);

    // The client exits: tmux is gone, lastTmux stays.
    sessions.clientList = [];
    keeper.entered(P1);
    await pass(clock, 3_000);
    const detached = store.last().panes[P1];
    // An attach to another session moves it.
    sessions.clientList = [{ tty: TTY, session: "notes" }];
    keeper.entered(P1);
    await pass(clock, 3_000);
    const moved = store.last().panes[P1];
    keeper.closed(P1);
    await pass(clock, 3_000);

    expect(detached).toMatchObject({ tmux: null, lastTmux: "work" });
    expect(moved).toMatchObject({ tmux: "notes", lastTmux: "notes" });
    expect(store.last().panes[P1]).toBeUndefined();
  });

  it("the stored cwd comes only from the shell's process, never from OSC 7", async () => {
    // The keeper has no way to learn a directory from output: its only source is the ProcessCwd port.
    const { store, cwds, keeper, clock } = setup();
    await keeper.load();
    cwds.cwds.set(PID, "/Users/alex");
    keeper.started(P1, PID, "/bin/zsh");
    keeper.output(P1, "\u001b]7;file://host/etc\u0007");
    keeper.entered(P1);
    await pass(clock, 3_000);

    expect(store.last().panes[P1]?.cwd).toBe("/Users/alex");
  });

  it("flush saves at once, without waiting for the debounce", async () => {
    const { store, cwds, keeper, clock } = setup();
    await keeper.load();
    cwds.cwds.set(PID, "/Users/alex");
    keeper.started(P1, PID, "/bin/zsh");
    keeper.entered(P1);
    await pass(clock, 1_100);

    await keeper.flush();

    expect(store.last().panes[P1]?.cwd).toBe("/Users/alex");
  });

  it.each([
    ["a live session named by tmux", { tmux: "work", lastTmux: "work" }, ["work"], { attach: "work", cwd: "/Users/alex/Dev" }],
    ["a live session named by lastTmux", { tmux: null, lastTmux: "work" }, ["work"], { attach: "work", cwd: "/Users/alex/Dev" }],
    ["a session not back yet", { tmux: null, lastTmux: "work" }, [], { shell: true, cwd: "/Users/alex/Dev", waitFor: "work" }],
    ["a cwd only", { tmux: null, lastTmux: null }, [], { shell: true, cwd: "/Users/alex/Dev", waitFor: null }],
  ])("the restore of a pane with %s", async (_, names, live, plan) => {
    const { sessions, keeper } = setup({ version: 1, panes: { [P1]: { cwd: "/Users/alex/Dev", shell: "/bin/zsh", ...names } } });
    for (const name of live) sessions.sessions.add(name);
    await keeper.load();

    expect(await keeper.plan(P1)).toEqual(plan);
  });

  it("two opens that arrive together both see panes.json: the second waits for the first's read", async () => {
    const { keeper } = setup({ version: 1, panes: { [P1]: { cwd: "/Users/alex", tmux: null, lastTmux: null, shell: "/bin/zsh" } } });

    const [, second] = await Promise.all([keeper.load(), keeper.load().then(() => keeper.plan(P1))]);

    expect(second).toEqual({ shell: true, cwd: "/Users/alex", waitFor: null });
  });

  it("a pane panes.json does not know has no restore", async () => {
    const { keeper } = setup({ version: 1, panes: {} });
    await keeper.load();

    expect(await keeper.plan(P2)).toBeNull();
  });
});
