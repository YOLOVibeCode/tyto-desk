import { describe, expect, it } from "vitest";
import {
  DESK_SKILL,
  LOGIN_AGENT_LABEL,
  NATIVE_HOST_NAME,
  TMUX_DESK_LINE,
  WEB_ACCESS_DESK_STEP,
  newDeskConfig,
  sha256Hex,
  uninstall,
} from "../src/index.ts";
import {
  FakeClock,
  FakeDaemonClient,
  FakeDevToolsHttp,
  FakeInstanceLock,
  FakeLaunchAgents,
  FakeProcessSignals,
  FakeTreeRemover,
  MemoryConfigStore,
  MemoryNativeHostDir,
  MemoryTextFiles,
  ScriptedPrompter,
} from "../src/testing/index.ts";

const home = "/Users/alex";
const deskHome = `${home}/.desk`;
const config = newDeskConfig({ home, platform: "darwin", chromePort: 9417, gatewayPort: 9583 });
const CLAUDE_SKILL = `${home}/.claude/skills/desk/SKILL.md`;
const CURSOR_SKILL = `${home}/.cursor/skills/desk/SKILL.md`;
const RULE = `${home}/.claude/rules/web-access.md`;
const TMUX = `${home}/.tmux.conf`;
const APP = `${home}/Applications/Desk.app`;
const TMUX_TEXT = `set -g mouse on\n# Desk: tmux sessions created from a Desk pane keep the Desk browser's variables.\n${TMUX_DESK_LINE}\n`;
const RULE_TEXT = `# Web access\n\n${WEB_ACCESS_DESK_STEP}1. **Public data**: call the API.\n`;

function setup(answers: (boolean | "no-tty")[], options: { recorded?: unknown[]; running?: boolean } = {}) {
  const files = new MemoryTextFiles({
    [`${home}/.local/bin/desk`]: "#!/bin/sh\n",
    [`${deskHome}/bin/desk-nmhost`]: "#!/bin/sh\n",
    [`${deskHome}/config.json`]: "{}",
    [CLAUDE_SKILL]: DESK_SKILL,
    [CURSOR_SKILL]: `${DESK_SKILL}\nmy note\n`,
    [RULE]: RULE_TEXT,
    [TMUX]: TMUX_TEXT,
    [`${APP}/Contents/MacOS/Desk`]: "#!/bin/sh\n",
    [`${home}/notes.txt`]: "mine",
    [`${config.chrome.userDataDir}/Default/Preferences`]: "{}",
    [`${deskHome}/installed.json`]: JSON.stringify({
      version: 1,
      current: "0.4.0",
      previous: null,
      versions: {},
      files: options.recorded ?? [
        { kind: "skill", path: CLAUDE_SKILL, sha256: sha256Hex(DESK_SKILL) },
        { kind: "skill", path: CURSOR_SKILL, sha256: sha256Hex(DESK_SKILL) },
        { kind: "rule-step", path: RULE },
        { kind: "tmux-line", path: TMUX },
        { kind: "desk-app", path: APP },
        { kind: "launch-agent", label: LOGIN_AGENT_LABEL },
      ],
    }),
  });
  const trees = new FakeTreeRemover(files);
  const hosts = new MemoryNativeHostDir();
  void hosts.write(NATIVE_HOST_NAME, "{}");
  const agents = new FakeLaunchAgents();
  void agents.install(LOGIN_AGENT_LABEL, ["desk"]);
  const lock = new FakeInstanceLock();
  lock.holders.set("watch", { pid: 6200, build: "0.4.0" });
  const signals = new FakeProcessSignals();
  signals.onTerminate = () => lock.holders.delete("watch");
  const daemon = new FakeDaemonClient();
  const prompter = new ScriptedPrompter(answers);
  const devTools = new FakeDevToolsHttp({ answering: options.running ?? false });
  const run = (profile = false) =>
    uninstall(
      { config: new MemoryConfigStore(config), files, trees, hostsFor: () => hosts, agents, lock, signals, daemon, prompter, devTools, clock: new FakeClock({ auto: true }) },
      { home, deskHome, profile },
    );
  return { files, trees, hosts, agents, lock, signals, daemon, prompter, run };
}

describe("desk uninstall (docs/IMPLEMENTATION.md §15.4)", () => {
  it("uninstall removes only what install recorded and keeps edited skills", async () => {
    // Uninstall? yes · stop the daemon? yes · remove ~/.desk? yes
    const desk = setup([true, true, true]);

    const result = await desk.run();

    expect(await desk.files.read(CLAUDE_SKILL)).toBeNull();
    expect(await desk.files.read(CURSOR_SKILL)).toBe(`${DESK_SKILL}\nmy note\n`);
    expect(await desk.files.read(RULE)).toBe("# Web access\n\n1. **Public data**: call the API.\n");
    expect(await desk.files.read(TMUX)).toBe("set -g mouse on\n");
    expect(await desk.files.read(`${APP}/Contents/MacOS/Desk`)).toBeNull();
    expect(await desk.agents.installed(LOGIN_AGENT_LABEL)).toBe(false);
    expect(await desk.hosts.read(NATIVE_HOST_NAME)).toBeNull();
    expect(await desk.files.read(`${home}/.local/bin/desk`)).toBeNull();
    expect(await desk.files.read(`${deskHome}/config.json`)).toBeNull();
    expect(await desk.files.read(`${home}/notes.txt`)).toBe("mine");
    expect(await desk.files.read(`${config.chrome.userDataDir}/Default/Preferences`)).toBe("{}");
    expect(result).toEqual({ code: 0, message: expect.stringContaining(`kept your edited ${CURSOR_SKILL}`) });
  });

  it("uninstall leaves files install never recorded", async () => {
    const desk = setup([true, true, true], { recorded: [] });

    await desk.run();

    expect(await desk.files.read(CLAUDE_SKILL)).toBe(DESK_SKILL);
    expect(await desk.files.read(TMUX)).toBe(TMUX_TEXT);
    expect(await desk.files.read(RULE)).toBe(RULE_TEXT);
  });

  it("uninstall stops desk watch, and the daemon only after you confirm", async () => {
    const declined = setup([true, false, false]);
    await declined.run();
    const agreed = setup([true, true, false]);
    await agreed.run();

    expect(declined.signals.terminated).toEqual([6200]);
    expect(declined.daemon.notices).toEqual([]);
    expect(agreed.daemon.notices).toEqual([{ type: "shutdown", mode: "stop" }]);
  });

  it("uninstall keeps ~/.desk when you say no, and removes its bin", async () => {
    const desk = setup([true, true, false]);

    await desk.run();

    expect(await desk.files.read(`${deskHome}/config.json`)).toBe("{}");
    expect(await desk.files.read(`${deskHome}/bin/desk-nmhost`)).toBeNull();
  });

  it("uninstall deletes the profile only with --profile and a second confirmation", async () => {
    const without = setup([true, true, true]);
    await without.run(false);
    const once = setup([true, true, true, false]);
    await once.run(true);
    const twice = setup([true, true, true, true, true]);
    await twice.run(true);

    const profile = `${config.chrome.userDataDir}/Default/Preferences`;
    expect(await without.files.read(profile)).toBe("{}");
    expect(await once.files.read(profile)).toBe("{}");
    expect(await twice.files.read(profile)).toBeNull();
    expect(twice.prompter.asked.slice(-2)).toEqual([
      expect.stringContaining("Delete the Desk Chrome's profile"),
      expect.stringContaining("cannot be undone"),
    ]);
  });

  it("uninstall changes nothing when you decline, and exits 77", async () => {
    const desk = setup([false]);

    expect(await desk.run()).toEqual({ code: 77, message: "Nothing was uninstalled: you declined" });
    expect(await desk.files.read(CLAUDE_SKILL)).toBe(DESK_SKILL);
    expect(desk.signals.terminated).toEqual([]);
  });

  it("uninstall needs an interactive terminal, and exits 64 without one", async () => {
    expect(await setup(["no-tty"]).run()).toMatchObject({ code: 64 });
  });

  it("uninstall refuses while the Desk Chrome runs, and names desk quit", async () => {
    const desk = setup([], { running: true });

    expect(await desk.run()).toEqual({ code: 75, message: "the Desk Chrome is running; run desk quit, then desk uninstall" });
  });
});
