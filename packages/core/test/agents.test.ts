import { describe, expect, it } from "vitest";
import {
  AGENT_VARIABLE_NAMES,
  FORBIDDEN_AGENT_BROWSER_KEYS,
  TMUX_DESK_LINE,
  agentBrowserConfig,
  agentGate,
  agentPolicy,
  newDeskConfig,
  paneEnvironment,
} from "../src/index.ts";
import { FakeTmux, MemoryTextFiles } from "../src/testing/index.ts";

const home = "/Users/alex";
const deskHome = "/Users/alex/.desk";
const config = newDeskConfig({ home, platform: "darwin", chromePort: 9417, gatewayPort: 9583 });
const parent = { HOME: home, USER: "alex", SHELL: "/bin/zsh", LANG: "en_US.UTF-8", TMUX: "/tmp/tmux-501/default,1,0" };

describe("the agent-browser config", () => {
  const file = agentBrowserConfig({ config, deskHome });

  it("the agent-browser config points cdp at the guarded endpoint with restoreSave never, pinTab, contentBoundaries, idleTimeout 15m and Desk's policy", () => {
    expect(file).toEqual({
      cdp: "http://127.0.0.1:9583",
      restoreSave: "never",
      pinTab: true,
      contentBoundaries: true,
      idleTimeout: "15m",
      actionPolicy: "/Users/alex/.desk/agent-policy.json",
    });
  });

  it.each(FORBIDDEN_AGENT_BROWSER_KEYS)("the agent-browser config has no %s", (key) => {
    expect(Object.keys(file)).not.toContain(key);
  });

  it("the forbidden keys are the ones that restore, name or relocate a session or a browser", () => {
    expect([...FORBIDDEN_AGENT_BROWSER_KEYS]).toEqual([
      "restore",
      "sessionName",
      "state",
      "namespace",
      "profile",
      "executablePath",
      "autoConnect",
    ]);
  });
});

describe("the agent policy", () => {
  it.each([
    ["open", { default: "allow" }],
    ["paused", { default: "deny", allow: ["close"] }],
  ] as const)("the %s policy is %j", (mode, policy) => {
    expect(agentPolicy(mode)).toEqual(policy);
  });

  it("the strict policy denies cookie, storage, state, credential and HAR actions", () => {
    expect(agentPolicy("strict")).toEqual({
      default: "allow",
      deny: [
        "cookies_get",
        "cookies_set",
        "cookies_clear",
        "storage_get",
        "storage_set",
        "storage_clear",
        "state_save",
        "state_load",
        "credentials_get",
        "auth_show",
        "har_start",
      ],
    });
  });
});

describe("the agent-variable gate", () => {
  const files = (contents: Record<string, string> = {}) => new MemoryTextFiles(contents);
  const lineIn = (path: string) => ({ [path]: `set -g mouse on\n${TMUX_DESK_LINE}\n` });

  it("pane env sets the agent variables when the running tmux server lists them in update-environment", async () => {
    const tmux = new FakeTmux({ running: true, names: ["DISPLAY", "SSH_AUTH_SOCK", ...AGENT_VARIABLE_NAMES] });
    const gate = await agentGate({ tmux, files: files(), home });

    const env = paneEnvironment({ parent, version: "0.3.0", config, deskHome, pane: "p_k2m9q3x7ab", gate });

    expect(gate).toEqual({ allowed: true });
    expect(env).toMatchObject({
      AGENT_BROWSER_CONFIG: "/Users/alex/.desk/agent-browser.json",
      AGENT_BROWSER_SESSION: "desk-p_k2m9q3x7ab",
      DESK_CDP_URL: "http://127.0.0.1:9583",
      DESK_PANE: "p_k2m9q3x7ab",
    });
    expect(env.TMUX).toBeUndefined();
  });

  it("pane env omits the agent variables while tmux lacks the update-environment line", async () => {
    const tmux = new FakeTmux({ running: true, names: ["DISPLAY", "SSH_AUTH_SOCK", "AGENT_BROWSER_CONFIG"] });
    const gate = await agentGate({ tmux, files: files(lineIn(`${home}/.tmux.conf`)), home });

    const env = paneEnvironment({ parent, version: "0.3.0", config, deskHome, pane: "p_k2m9q3x7ab", gate });

    expect(gate).toEqual({ allowed: false, notice: "tmux-line-missing" });
    for (const name of AGENT_VARIABLE_NAMES) expect(env[name]).toBeUndefined();
    expect(env.TERM_PROGRAM).toBe("Desk");
  });

  it("pane env sets the agent variables when tmux is not installed", async () => {
    expect(await agentGate({ tmux: null, files: files(), home })).toEqual({ allowed: true });
  });

  it.each([`${home}/.tmux.conf`, `${home}/.config/tmux/tmux.conf`])(
    "with no tmux server running, pane env sets the agent variables when %s holds Desk's exact line",
    async (path) => {
      expect(await agentGate({ tmux: new FakeTmux({ running: false }), files: files(lineIn(path)), home })).toEqual({ allowed: true });
    },
  );

  it.each([
    ["no tmux config", {}],
    ["a config without the line", { [`${home}/.tmux.conf`]: "set -g mouse on\n" }],
    ["the line commented out", { [`${home}/.tmux.conf`]: `# ${TMUX_DESK_LINE}\n` }],
    ["a line naming three of the four variables", { [`${home}/.tmux.conf`]: TMUX_DESK_LINE.replace(" DESK_PANE", "") }],
  ])("with no tmux server running, pane env omits the agent variables with %s", async (_label, contents) => {
    expect(await agentGate({ tmux: new FakeTmux({ running: false }), files: files(contents), home })).toEqual({
      allowed: false,
      notice: "tmux-line-missing",
    });
  });

  it("Desk's tmux line adds the four agent variables to update-environment", () => {
    expect(TMUX_DESK_LINE).toBe('set -ga update-environment " AGENT_BROWSER_CONFIG AGENT_BROWSER_SESSION DESK_CDP_URL DESK_PANE"');
    expect([...AGENT_VARIABLE_NAMES]).toEqual(["AGENT_BROWSER_CONFIG", "AGENT_BROWSER_SESSION", "DESK_CDP_URL", "DESK_PANE"]);
  });
});
