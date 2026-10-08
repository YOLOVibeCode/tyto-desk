import { describe, expect, it } from "vitest";
import { TMUX_DESK_LINE, addTmuxLine } from "../src/index.ts";
import { FakeTmux, MemoryTextFiles, ScriptedPrompter } from "../src/testing/index.ts";

const home = "/Users/alex";
const CONF = `${home}/.tmux.conf`;
const NAMES = ["AGENT_BROWSER_CONFIG", "AGENT_BROWSER_SESSION", "DESK_CDP_URL", "DESK_PANE"];

function setup(options: { conf?: string; running?: boolean; names?: string[]; answers?: (boolean | "no-tty")[] } = {}) {
  const files = new MemoryTextFiles(options.conf === undefined ? {} : { [CONF]: options.conf });
  const tmux = new FakeTmux({ running: options.running ?? false, names: options.names ?? ["DISPLAY", "SSH_AUTH_SOCK"] });
  const prompter = new ScriptedPrompter(options.answers ?? []);
  return { files, tmux, prompter, run: () => addTmuxLine({ files, tmux, prompter }, { home }) };
}

describe("install's tmux line (docs/IMPLEMENTATION.md §11)", () => {
  it("install appends the tmux line once, after consent, and applies it to a running tmux server", async () => {
    const desk = setup({ conf: "set -g mouse on\n", running: true, answers: [true] });

    const first = await desk.run();
    const second = await desk.run();

    expect(first).toEqual({ added: true, note: null });
    expect(second).toEqual({ added: false, note: null });
    expect(desk.prompter.asked).toHaveLength(1);
    expect((await desk.files.read(CONF))?.split("\n").filter((line) => line === TMUX_DESK_LINE)).toHaveLength(1);
    expect(await desk.files.read(CONF)).toMatch(/^set -g mouse on\n# Desk: .*\nset -ga update-environment " AGENT_BROWSER_CONFIG AGENT_BROWSER_SESSION DESK_CDP_URL DESK_PANE"\n$/);
    expect(desk.tmux.appended).toEqual([NAMES]);
  });

  it("install writes nothing when you decline the tmux line, and says what that means", async () => {
    const desk = setup({ conf: "set -g mouse on\n", running: true, answers: [false] });

    const result = await desk.run();

    expect(await desk.files.read(CONF)).toBe("set -g mouse on\n");
    expect(desk.tmux.appended).toEqual([]);
    expect(result.note).toMatch(/declined the tmux line/);
  });

  it("install asks nothing when the file and the running server already have the line", async () => {
    const desk = setup({ conf: `${TMUX_DESK_LINE}\n`, running: true, names: NAMES });

    expect(await desk.run()).toEqual({ added: false, note: null });
    expect(desk.prompter.asked).toEqual([]);
  });

  it("install gives a running server the line the file already has", async () => {
    const desk = setup({ conf: `${TMUX_DESK_LINE}\n`, running: true, answers: [true] });

    await desk.run();

    expect(desk.tmux.appended).toEqual([NAMES]);
    expect((await desk.files.read(CONF))?.match(/update-environment/g)).toHaveLength(1);
  });

  it("install creates ~/.tmux.conf with the line when there is none", async () => {
    const desk = setup({ answers: [true] });

    await desk.run();

    expect(await desk.files.read(CONF)).toBe(`# Desk: tmux sessions created from a Desk pane keep the Desk browser's variables.\n${TMUX_DESK_LINE}\n`);
  });

  it("install leaves the tmux line for later without a terminal to ask on", async () => {
    const desk = setup({ answers: ["no-tty"] });

    expect((await desk.run()).note).toMatch(/interactive terminal/);
    expect(await desk.files.read(CONF)).toBeNull();
  });

  it("install asks nothing about tmux when tmux is not installed", async () => {
    const files = new MemoryTextFiles({});
    const prompter = new ScriptedPrompter([]);

    expect(await addTmuxLine({ files, tmux: null, prompter }, { home })).toEqual({ added: false, note: null });
  });
});
