import { DESK_PORT_MAX, DESK_PORT_MIN, type DeskConfig } from "../config/schema.ts";

/**
 * Chrome switches Desk never passes, by name without dashes, from the config or anywhere else. They set
 * `navigator.webdriver`, add the automation infobar, turn off password saving and filling, open the port beyond
 * loopback or to web pages, or weaken the sandbox (docs/IMPLEMENTATION.md §0 Chrome law, §5).
 */
export const FORBIDDEN_CHROME_SWITCHES: readonly string[] = [
  "remote-debugging-pipe",
  "enable-automation",
  "headless",
  "remote-allow-origins",
  "remote-debugging-address",
  "load-extension",
  "use-mock-keychain",
  "no-sandbox",
  "disable-web-security",
];

/** Set by chromeArgs alone. A second one in extraArgs would win, because Chrome keeps a switch's last value. */
const DESK_OWNED_SWITCHES: readonly string[] = ["remote-debugging-port", "user-data-dir"];

export type ChromeArgsRefusal = "forbidden-switch" | "port-out-of-range" | "default-profile";

export type ChromeArgsInput = {
  chrome: DeskConfig["chrome"];
  /** `chrome.userDataDir` with symlinks resolved by the caller. */
  userDataDirReal: string;
  /** Chrome's own default user-data directories (`chromeDefaultDirs`), symlinks resolved where they exist. */
  chromeDefaultDirsReal: readonly string[];
};

export type ChromeArgsResult =
  | { ok: true; args: readonly string[] }
  | { ok: false; reason: ChromeArgsRefusal; refused: string };

/** Where Chrome keeps the profile it uses without `--user-data-dir`. Branded Chrome refuses the port there anyway. */
export function chromeDefaultDirs(home: string, platform: string): readonly string[] {
  const base = home.replace(/\/+$/, "");
  if (platform === "darwin") return [`${base}/Library/Application Support/Google/Chrome`];
  if (platform === "linux") return [`${base}/.config/google-chrome`];
  return [];
}

/** Chromium on macOS and Linux reads `--name[=value]` and `-name[=value]`. Lower case, to refuse generously. */
function switchName(arg: string): string | null {
  const body = arg.startsWith("--") ? arg.slice(2) : arg.startsWith("-") ? arg.slice(1) : null;
  if (body === null) return null;
  const name = body.split("=", 1)[0] ?? "";
  return name === "" ? null : name.toLowerCase();
}

/** Case-insensitive, as the default macOS volume is. */
function within(path: string, dir: string): boolean {
  const p = path.toLowerCase().replace(/\/+$/, "");
  const d = dir.toLowerCase().replace(/\/+$/, "");
  return p === d || p.startsWith(`${d}/`);
}

/**
 * The only arguments Desk starts Chrome with: the stored port and the Desk profile first, no first-run prompts,
 * session restore on every launch, then the user's extraArgs. Refuses a port outside Desk's range, a profile whose
 * real path is Chrome's default directory or inside it, and any forbidden or Desk-owned switch in extraArgs.
 */
export function chromeArgs(input: ChromeArgsInput): ChromeArgsResult {
  const { chrome } = input;
  const portArg = `--remote-debugging-port=${chrome.port}`;
  if (!Number.isInteger(chrome.port) || chrome.port < DESK_PORT_MIN || chrome.port > DESK_PORT_MAX) {
    return { ok: false, reason: "port-out-of-range", refused: portArg };
  }
  const profileArg = `--user-data-dir=${chrome.userDataDir}`;
  if (input.chromeDefaultDirsReal.some((dir) => within(input.userDataDirReal, dir))) {
    return { ok: false, reason: "default-profile", refused: profileArg };
  }
  for (const arg of chrome.extraArgs) {
    const name = switchName(arg);
    const forbidden =
      arg.includes("\0") ||
      (name !== null && (FORBIDDEN_CHROME_SWITCHES.includes(name) || DESK_OWNED_SWITCHES.includes(name)));
    if (forbidden) return { ok: false, reason: "forbidden-switch", refused: arg };
  }
  return {
    ok: true,
    args: [
      portArg,
      profileArg,
      "--no-first-run",
      "--no-default-browser-check",
      "--restore-last-session",
      "--hide-crash-restore-bubble",
      ...chrome.extraArgs,
    ],
  };
}
