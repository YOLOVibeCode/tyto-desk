import { describe, expect, it } from "vitest";
import { DESK_SKILL, TMUX_DESK_LINE, WEB_ACCESS_DESK_STEP, installExtras, parseInstalled, sha256Hex } from "../src/index.ts";
import { FakeClock, FakeCodeSigning, FakeInstanceLock, FakeLaunchAgents, FakeTmux, MemoryTextFiles, ScriptedPrompter } from "../src/testing/index.ts";

const home = "/Users/alex";
const deskHome = `${home}/.desk`;
const CLAUDE_SKILL = `${home}/.claude/skills/desk/SKILL.md`;
const CURSOR_SKILL = `${home}/.cursor/skills/desk/SKILL.md`;
const CLAUDE_RULE = `${home}/.claude/rules/web-access.md`;
const CURSOR_RULE = `${home}/.cursor/rules/web-access.mdc`;
const RULE = "# Web access\n\n1. **Public data with an API**: call the API.\n2. **Static public page**: WebFetch.\n";
const INSTALLED = JSON.stringify({ version: 1, current: "0.4.0", previous: null, versions: {}, files: [] });

function setup(options: { answers?: (boolean | "no-tty")[]; platform?: string; gui?: boolean; files?: Record<string, string> } = {}) {
  const files = new MemoryTextFiles({ [`${deskHome}/installed.json`]: INSTALLED, [CLAUDE_RULE]: RULE, [CURSOR_RULE]: RULE, ...options.files });
  const prompter = new ScriptedPrompter(options.answers ?? []);
  const tmux = new FakeTmux({ running: false });
  const signing = new FakeCodeSigning();
  const agents = new FakeLaunchAgents();
  const lock = new FakeInstanceLock();
  const run = () =>
    installExtras(
      { lock, files, prompter, tmux, signing, agents, clock: new FakeClock({ auto: true }) },
      { home, deskHome, platform: options.platform ?? "darwin", guiAllowed: options.gui ?? true },
    );
  return { files, prompter, tmux, signing, agents, lock, run };
}

const recorded = async (files: MemoryTextFiles) => parseInstalled((await files.read(`${deskHome}/installed.json`)) ?? "")?.files ?? [];

describe("install's skills (docs/IMPLEMENTATION.md §11, §15.1)", () => {
  it("install writes the desk skill for Claude Code and Cursor and records each one's sha256", async () => {
    const desk = setup({ answers: [false, false, false, false] });

    await desk.run();

    expect(await desk.files.read(CLAUDE_SKILL)).toBe(DESK_SKILL);
    expect(await desk.files.read(CURSOR_SKILL)).toBe(DESK_SKILL);
    expect(await recorded(desk.files)).toEqual(
      expect.arrayContaining([
        { kind: "skill", path: CLAUDE_SKILL, sha256: sha256Hex(DESK_SKILL) },
        { kind: "skill", path: CURSOR_SKILL, sha256: sha256Hex(DESK_SKILL) },
      ]),
    );
  });

  it("install keeps a skill the user edited", async () => {
    // Each run asks again for the steps declined before: their result is still missing.
    const desk = setup({ answers: [false, false, false, false, false, false, false, false] });
    await desk.run();
    await desk.files.write(CLAUDE_SKILL, `${DESK_SKILL}\nMy own note.\n`, 0o644);

    const second = await desk.run();

    expect(await desk.files.read(CLAUDE_SKILL)).toBe(`${DESK_SKILL}\nMy own note.\n`);
    expect(second).toMatchObject({ ok: true, notes: expect.arrayContaining([`kept your edited ${CLAUDE_SKILL}`]) });
  });

  it("install replaces a skill it wrote and you did not edit", async () => {
    const desk = setup({ answers: [false, false, false, false], files: { [CLAUDE_SKILL]: "an older desk skill\n" } });
    const old = (await desk.files.read(`${deskHome}/installed.json`)) ?? "";
    await desk.files.write(
      `${deskHome}/installed.json`,
      JSON.stringify({ ...JSON.parse(old), files: [{ kind: "skill", path: CLAUDE_SKILL, sha256: sha256Hex("an older desk skill\n") }] }),
      0o600,
    );

    await desk.run();

    expect(await desk.files.read(CLAUDE_SKILL)).toBe(DESK_SKILL);
  });
});

describe("install's consent steps (docs/IMPLEMENTATION.md §15.1)", () => {
  it("install adds the desk step to the web-access rules once, after consent", async () => {
    const desk = setup({ answers: [true, false, false, false, false, false, false] });

    await desk.run();
    await desk.run();

    expect(desk.prompter.asked.filter((q) => q.includes("web-access"))).toHaveLength(1);
    for (const rule of [CLAUDE_RULE, CURSOR_RULE]) {
      const text = (await desk.files.read(rule)) ?? "";
      expect(text.split(WEB_ACCESS_DESK_STEP).length - 1).toBe(1);
      expect(text.indexOf(WEB_ACCESS_DESK_STEP)).toBeLessThan(text.indexOf("1. **Public data"));
    }
  });

  it("install leaves the web-access rules alone when you decline", async () => {
    const desk = setup({ answers: [false, false, false, false] });

    await desk.run();

    expect(await desk.files.read(CLAUDE_RULE)).toBe(RULE);
  });

  it("install adds Desk.app and the login agent only after consent", async () => {
    const declined = setup({ answers: [false, false, false, false] });
    await declined.run();
    const agreed = setup({ answers: [false, false, true, true] });
    await agreed.run();

    expect(await declined.files.read(`${home}/Applications/Desk.app/Contents/MacOS/Desk`)).toBeNull();
    expect(await declined.agents.installed("com.noctusoft.desk.login")).toBe(false);
    expect(await agreed.files.read(`${home}/Applications/Desk.app/Contents/MacOS/Desk`)).toBe(`#!/bin/sh\nexec '${home}/.local/bin/desk' "$@"\n`);
    expect(agreed.signing.signed).toEqual([{ bundle: `${home}/Applications/Desk.app`, identifier: "com.noctusoft.desk.app" }]);
    expect(agreed.agents.agents.get("com.noctusoft.desk.login")).toEqual([`${home}/.local/bin/desk`]);
  });

  it("install offers neither Desk.app nor the login agent on Linux, or where Desk may not open windows", async () => {
    const linux = setup({ platform: "linux", answers: [false, false] });
    await linux.run();
    const noGui = setup({ gui: false, answers: [false, false] });
    await noGui.run();

    expect(linux.prompter.asked.some((q) => q.includes("Desk.app") || q.includes("login"))).toBe(false);
    expect(noGui.prompter.asked.some((q) => q.includes("Desk.app") || q.includes("login"))).toBe(false);
  });

  it("install --from on an existing install runs only the version steps and asks again only for consent steps whose result is missing", async () => {
    const desk = setup({ answers: [true, true, true, false] });
    await desk.run();
    const asked = desk.prompter.asked.length;

    const again = setup({ answers: [true] });
    for (const [path, text] of [
      [CLAUDE_RULE, await desk.files.read(CLAUDE_RULE)],
      [CURSOR_RULE, await desk.files.read(CURSOR_RULE)],
      [`${home}/.tmux.conf`, await desk.files.read(`${home}/.tmux.conf`)],
      [`${home}/Applications/Desk.app/Contents/MacOS/Desk`, await desk.files.read(`${home}/Applications/Desk.app/Contents/MacOS/Desk`)],
      [`${deskHome}/installed.json`, await desk.files.read(`${deskHome}/installed.json`)],
    ] as const) {
      if (text !== null) await again.files.write(path, text, 0o644);
    }
    await again.run();

    expect(asked).toBe(4);
    expect(again.prompter.asked).toEqual([expect.stringContaining("login")]);
  });

  it("install records the steps it took, so uninstall removes only those", async () => {
    const desk = setup({ answers: [true, true, true, true] });

    await desk.run();

    expect((await recorded(desk.files)).map((entry) => (entry as { kind: string }).kind).sort()).toEqual([
      "desk-app",
      "launch-agent",
      "rule-step",
      "rule-step",
      "skill",
      "skill",
      "tmux-line",
    ]);
  });

  it("install holds run/install.lock while it records what it wrote", async () => {
    const desk = setup({ answers: [false, false, false, false] });

    await desk.run();

    expect(desk.lock.acquired).toEqual(["install"]);
    expect(desk.lock.released).toEqual(["install"]);
  });

  it("the tmux line is among install's consent steps", async () => {
    const desk = setup({ answers: [false, true, false, false] });

    await desk.run();

    expect(await desk.files.read(`${home}/.tmux.conf`)).toContain(TMUX_DESK_LINE);
  });
});

describe("sha256Hex", () => {
  it.each(["", "abc", "Desk ✓ 🦉", "line\nline\n"])("sha256Hex(%j) is the sha256 of the text's UTF-8 bytes", async (text) => {
    const { createHash } = await import("node:crypto");

    expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  });
});
