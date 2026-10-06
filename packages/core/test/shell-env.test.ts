import { describe, expect, it } from "vitest";
import { shellEnv, type Env } from "../src/index.ts";

/** A parent environment as Chrome hands it to the daemon, with fake values throughout. */
const parent: Env = {
  HOME: "/Users/alex",
  USER: "alex",
  LOGNAME: "alex",
  SHELL: "/bin/zsh",
  TMPDIR: "/var/folders/xy/T/",
  SSH_AUTH_SOCK: "/private/tmp/com.apple.launchd.fake/Listeners",
  __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  LC_CTYPE: "UTF-8",
  LC_MESSAGES: "C",
  LC_TIME: "en_GB.UTF-8",
  LC_NUMERIC: "utf8-fake0123456789",
  LC_TERMINAL: "iTerm2",
  LC_TERMINAL_VERSION: "3.5.0",
  LC_API_TOKEN: "utf8-fake0123456789",
  PATH: "/Users/alex/.nvm/versions/node/v26.10.0/bin:/opt/homebrew/bin:/usr/bin:/bin",
  TERM: "dumb",
  ANTHROPIC_API_KEY: "fake",
  OPENAI_API_KEY: "fake",
  GITHUB_TOKEN: "fake",
  TMUX: "/private/tmp/tmux-501/default,1,0",
  TMUX_PANE: "%1",
  ELECTRON_RUN_AS_NODE: "1",
  ELECTRON_NO_ATTACH_CONSOLE: "1",
  NODE_OPTIONS: "--require /tmp/x.js",
  NO_COLOR: "1",
  FORCE_COLOR: "1",
  CLICOLOR_FORCE: "1",
  AGENT_BROWSER_CDP: "http://127.0.0.1:9222",
  AGENT_BROWSER_NAMESPACE: "work",
  AGENT_BROWSER_RESTORE: "main",
  AGENT_BROWSER_RESTORE_SAVE: "always",
  AGENT_BROWSER_PIN_TAB: "1",
  AGENT_BROWSER_CONFIG: "/Users/alex/.agent-browser/config.json",
  AGENT_BROWSER_SESSION: "main",
  DESK_CDP_URL: "http://127.0.0.1:9999",
  DESK_PANE: "p_0000000000",
  DYLD_INSERT_LIBRARIES: "/tmp/x.dylib",
  LD_PRELOAD: "/tmp/x.so",
};

const agent = {
  config: "/Users/alex/.desk/agent-browser.json",
  session: "desk-p_k2m9q3x7ab",
  cdpUrl: "http://127.0.0.1:9583",
  pane: "p_k2m9q3x7ab",
};

function env(overrides: Env = {}, withAgent = false): Record<string, string> {
  return shellEnv({ parent: { ...parent, ...overrides }, version: "0.1.0", agent: withAgent ? agent : null });
}

describe("shellEnv", () => {
  it.each([
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "SSH_AUTH_SOCK",
    "__CF_USER_TEXT_ENCODING",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LC_TIME",
  ])("shellEnv keeps %s", (name) => {
    expect(env()[name]).toBe(parent[name]);
  });

  it.each(["UTF-8", "utf8", "en_US.UTF-8", "C.UTF-8", "es_419.UTF-8", "sr_RS.utf8@latin", "de_DE.utf-8"])(
    "shellEnv keeps LC_CTYPE=%s, a UTF-8 locale",
    (value) => {
      expect(env({ LC_CTYPE: value }).LC_CTYPE).toBe(value);
    },
  );

  it.each(["utf8-fake0123456789", "en_US.UTF-8; touch /tmp/x", "UTF-8x", "en_US.ISO8859-1", "C", ""])(
    "shellEnv drops LC_CTYPE=%j, which is not a UTF-8 locale",
    (value) => {
      expect(env({ LC_CTYPE: value })).not.toHaveProperty("LC_CTYPE");
    },
  );

  it.each([
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GITHUB_TOKEN",
    "TMUX",
    "TMUX_PANE",
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_NO_ATTACH_CONSOLE",
    "NODE_OPTIONS",
    "NO_COLOR",
    "FORCE_COLOR",
    "CLICOLOR_FORCE",
    "AGENT_BROWSER_CDP",
    "AGENT_BROWSER_NAMESPACE",
    "AGENT_BROWSER_RESTORE",
    "AGENT_BROWSER_RESTORE_SAVE",
    "AGENT_BROWSER_PIN_TAB",
    "AGENT_BROWSER_CONFIG",
    "AGENT_BROWSER_SESSION",
    "DESK_CDP_URL",
    "DESK_PANE",
    "DYLD_INSERT_LIBRARIES",
    "LD_PRELOAD",
    "LC_MESSAGES",
    "LC_NUMERIC",
    "LC_TERMINAL",
    "LC_TERMINAL_VERSION",
    "LC_API_TOKEN",
  ])("shellEnv drops %s", (name) => {
    expect(env()).not.toHaveProperty(name);
  });

  it("shellEnv sets PATH to the system default, for the login shell to build on", () => {
    expect(env().PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
  });

  it("shellEnv sets the terminal's identity", () => {
    expect(env()).toMatchObject({
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      CLICOLOR: "1",
      TERM_PROGRAM: "Desk",
      TERM_PROGRAM_VERSION: "0.1.0",
    });
  });

  it("shellEnv sets LANG=en_US.UTF-8 when no UTF-8 locale is set", () => {
    const result = env({ LANG: "C", LC_ALL: undefined, LC_CTYPE: "ISO-8859-1" });

    expect(result.LANG).toBe("en_US.UTF-8");
    expect(result).not.toHaveProperty("LC_CTYPE");
  });

  it("shellEnv keeps a UTF-8 LC_CTYPE without adding LANG", () => {
    const result = env({ LANG: undefined, LC_ALL: undefined, LC_CTYPE: "UTF-8" });

    expect(result.LC_CTYPE).toBe("UTF-8");
    expect(result).not.toHaveProperty("LANG");
  });

  it("shellEnv sets the four agent variables only when the agent gate passes them", () => {
    expect(env({}, true)).toMatchObject({
      AGENT_BROWSER_CONFIG: agent.config,
      AGENT_BROWSER_SESSION: agent.session,
      DESK_CDP_URL: agent.cdpUrl,
      DESK_PANE: agent.pane,
    });
  });

  it("shellEnv passes no variable the policy does not name", () => {
    expect(Object.keys(env({}, true)).sort()).toEqual(
      [
        "AGENT_BROWSER_CONFIG",
        "AGENT_BROWSER_SESSION",
        "CLICOLOR",
        "COLORTERM",
        "DESK_CDP_URL",
        "DESK_PANE",
        "HOME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "LC_TIME",
        "LOGNAME",
        "PATH",
        "SHELL",
        "SSH_AUTH_SOCK",
        "TERM",
        "TERM_PROGRAM",
        "TERM_PROGRAM_VERSION",
        "TMPDIR",
        "USER",
        "__CF_USER_TEXT_ENCODING",
      ].sort(),
    );
  });
});
