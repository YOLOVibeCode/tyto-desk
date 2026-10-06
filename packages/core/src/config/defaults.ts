import type { DeskConfig } from "./schema.ts";

type PlatformDefaults = {
  app: string;
  /** Under the user's home: never Chrome's own default directory. */
  profile: string;
  toggleKey: string;
};

/** macOS for the operator; Linux only inside the Desk test container. */
const PLATFORMS: Readonly<Record<string, PlatformDefaults>> = {
  darwin: {
    app: "/Applications/Google Chrome.app",
    profile: "Library/Application Support/Desk/Chrome",
    toggleKey: "Command+Shift+Period",
  },
  linux: {
    app: "/usr/bin/google-chrome-stable",
    profile: ".config/Desk/Chrome",
    toggleKey: "Ctrl+Shift+Period",
  },
};

export function platformSupported(platform: string): boolean {
  return Object.hasOwn(PLATFORMS, platform);
}

export type NewConfigInput = {
  home: string;
  platform: string;
  chromePort: number;
  gatewayPort: number;
};

/** A first-run config (docs/IMPLEMENTATION.md §4.2) around two ports that were free when it was made. */
export function newDeskConfig(input: NewConfigInput): DeskConfig {
  const defaults = Object.hasOwn(PLATFORMS, input.platform) ? PLATFORMS[input.platform] : undefined;
  if (defaults === undefined) throw new RangeError(`Desk does not run on ${input.platform}`);
  const home = input.home.replace(/\/+$/, "");
  return {
    version: 1,
    chrome: {
      app: defaults.app,
      userDataDir: `${home}/${defaults.profile}`,
      port: input.chromePort,
      minMajor: 155,
      extraArgs: [],
      idleQuitMinutes: 10,
      relaunchAfterCrash: true,
      setContinuePref: false,
    },
    gateway: { port: input.gatewayPort, focusGuard: "auto" },
    panel: { toggleKey: defaults.toggleKey },
    terminal: {
      shell: null,
      tmux: null,
      scrollback: 5000,
      fontFamily: "Menlo, 'SF Mono', monospace",
      fontSize: 13,
      macOptionIsMeta: false,
      closeOnExit: true,
      osc52Write: false,
      keymap: {},
    },
    agents: { sessionPrefix: "desk", policy: "open", idleTimeout: "15m" },
  };
}
