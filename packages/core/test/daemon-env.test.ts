import { describe, expect, it } from "vitest";
import { daemonEnvironment } from "../src/index.ts";

const chromeEnv = {
  HOME: "/Users/alex",
  USER: "alex",
  LOGNAME: "alex",
  SHELL: "/bin/zsh",
  TMPDIR: "/var/folders/xy/T/",
  PATH: "/usr/bin:/bin",
  LANG: "en_US.UTF-8",
  LC_CTYPE: "UTF-8",
  SSH_AUTH_SOCK: "/private/tmp/com.apple.launchd.x/Listeners",
  __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
  TMUX_TMPDIR: "/tmp",
  DESK_HOME: "/Users/alex/.desk",
  ANTHROPIC_API_KEY: "x",
  NODE_OPTIONS: "--require /tmp/evil.js",
  TMUX: "/tmp/tmux-501/default,1,0",
  CHROME_DESKTOP: "google-chrome.desktop",
};

describe("the daemon's environment", () => {
  it.each(Object.keys(chromeEnv).filter((name) => !["ANTHROPIC_API_KEY", "NODE_OPTIONS", "TMUX", "CHROME_DESKTOP"].includes(name)))(
    "the host passes %s from Chrome's environment to the daemon it starts",
    (name) => {
      expect(daemonEnvironment(chromeEnv)[name]).toBe(chromeEnv[name as keyof typeof chromeEnv]);
    },
  );

  it.each(["ANTHROPIC_API_KEY", "NODE_OPTIONS", "TMUX", "CHROME_DESKTOP"])("the host never passes %s to the daemon", (name) => {
    expect(daemonEnvironment(chromeEnv)[name]).toBeUndefined();
  });
});
