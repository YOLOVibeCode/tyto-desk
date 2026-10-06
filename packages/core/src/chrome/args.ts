import { DESK_PORT_MAX, DESK_PORT_MIN, type DeskConfig } from "../config/schema.ts";

/**
 * Chrome switches Desk never passes, by name without dashes, from the config or anywhere else (docs/IMPLEMENTATION.md
 * §0 Chrome law, §5). Each one sets `navigator.webdriver` or adds the automation infobar, opens the debugging port
 * beyond loopback or to web pages, loads code Desk did not load, swaps the real keychain for a fake one, weakens the
 * sandbox or site isolation, or grants the camera and microphone without asking.
 */
export const FORBIDDEN_CHROME_SWITCHES: readonly string[] = [
  "remote-debugging-pipe",
  "remote-debugging-io-pipes",
  "enable-automation",
  "headless",
  "remote-allow-origins",
  "remote-debugging-address",
  "load-extension",
  "use-mock-keychain",
  "no-sandbox",
  "disable-gpu-sandbox",
  "disable-setuid-sandbox",
  "no-zygote",
  "disable-site-isolation-trials",
  "disable-web-security",
  "use-fake-ui-for-media-stream",
];

/**
 * Switches Desk refuses only with one of these values, compared without case in the switch's comma-separated list.
 * `AutomationControlled` sets `navigator.webdriver` without `--enable-automation`; `basic` is Linux's unencrypted
 * password store, the counterpart of `--use-mock-keychain`.
 */
export const FORBIDDEN_CHROME_SWITCH_VALUES: readonly { name: string; values: readonly string[] }[] = [
  { name: "enable-blink-features", values: ["automationcontrolled"] },
  { name: "password-store", values: ["basic"] },
];

/** Set by chromeArgs alone. A second one in extraArgs would win, because Chrome keeps a switch's last value. */
const DESK_OWNED_SWITCHES: readonly string[] = ["remote-debugging-port", "user-data-dir"];

/** macOS reaches every home through this firmlink too, and `realpath` keeps whichever spelling it was given. */
const DATA_VOLUME = "/System/Volumes/Data";

const MAC_CHANNELS = ["Chrome", "Chrome Beta", "Chrome Dev", "Chrome Canary"];
const LINUX_CHANNELS = ["google-chrome", "google-chrome-beta", "google-chrome-unstable", "google-chrome-canary"];

/**
 * - `forbidden-switch`: extraArgs hold a forbidden or Desk-owned switch.
 * - `port-out-of-range`: the stored port is outside 9400–9899.
 * - `profile-path`: the configured or real user-data-dir is not a plain absolute path.
 * - `default-dirs-unknown`: the caller gave no Chrome default directories, or a relative one, so nothing can be judged.
 * - `default-profile`: the configured or real user-data-dir is a Chrome default directory or inside one.
 */
export type ChromeArgsRefusal =
  | "forbidden-switch"
  | "port-out-of-range"
  | "profile-path"
  | "default-dirs-unknown"
  | "default-profile";

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

/**
 * Where each Chrome channel keeps the profile it uses without `--user-data-dir`, on macOS under both spellings of the
 * home (`/Users/…` and `/System/Volumes/Data/Users/…`). Branded Chrome refuses the port there anyway. Empty on a
 * platform Desk does not run on, which chromeArgs refuses.
 */
export function chromeDefaultDirs(home: string, platform: string): readonly string[] {
  const base = home.replace(/\/+$/, "");
  if (platform === "darwin") {
    const canonical = base.startsWith(`${DATA_VOLUME}/`) ? base.slice(DATA_VOLUME.length) : base;
    const homes = canonical.startsWith("/") ? [canonical, `${DATA_VOLUME}${canonical}`] : [canonical];
    return homes.flatMap((h) => MAC_CHANNELS.map((channel) => `${h}/Library/Application Support/Google/${channel}`));
  }
  if (platform === "linux") return LINUX_CHANNELS.map((channel) => `${base}/.config/${channel}`);
  return [];
}

/** Chromium on macOS and Linux reads `--name[=value]` and `-name[=value]`. Lower case, to refuse generously. */
function parseSwitch(arg: string): { name: string; value: string } | null {
  const body = arg.startsWith("--") ? arg.slice(2) : arg.startsWith("-") ? arg.slice(1) : null;
  if (body === null) return null;
  const equals = body.indexOf("=");
  const name = (equals === -1 ? body : body.slice(0, equals)).toLowerCase();
  return name === "" ? null : { name, value: equals === -1 ? "" : body.slice(equals + 1) };
}

function forbiddenSwitch(arg: string): boolean {
  if (arg.includes("\0")) return true;
  const parsed = parseSwitch(arg);
  if (parsed === null) return false;
  if (FORBIDDEN_CHROME_SWITCHES.includes(parsed.name) || DESK_OWNED_SWITCHES.includes(parsed.name)) return true;
  const rule = FORBIDDEN_CHROME_SWITCH_VALUES.find((entry) => entry.name === parsed.name);
  if (rule === undefined) return false;
  const values = parsed.value.split(",").map((value) => value.trim().toLowerCase());
  return rule.values.some((value) => values.includes(value));
}

/**
 * `path` with repeated slashes, `.` and `..` resolved lexically, in lower case (the default macOS volume ignores case),
 * or `null` when it is not a plain absolute path. Callers resolve symlinks; this keeps a sloppy spelling from passing.
 */
function normalizedPath(path: string): string | null {
  if (!path.startsWith("/") || path.includes("\0")) return null;
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`.toLowerCase();
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir === "/" ? "/" : `${dir}/`);
}

function allNormalized(paths: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const path of paths) {
    const normal = normalizedPath(path);
    if (normal === null) return null;
    out.push(normal);
  }
  return out;
}

/**
 * The only arguments Desk starts Chrome with: the stored port and the Desk profile first, no first-run prompts,
 * session restore on every launch, then the user's extraArgs. Refuses a port outside Desk's range; a configured or real
 * user-data-dir that is not absolute or that is a Chrome default directory or inside one; a missing list of default
 * directories; and any forbidden or Desk-owned switch in extraArgs.
 */
export function chromeArgs(input: ChromeArgsInput): ChromeArgsResult {
  const settings = input.chrome;
  const portArg = `--remote-debugging-port=${settings.port}`;
  if (!Number.isInteger(settings.port) || settings.port < DESK_PORT_MIN || settings.port > DESK_PORT_MAX) {
    return { ok: false, reason: "port-out-of-range", refused: portArg };
  }
  const profileArg = `--user-data-dir=${settings.userDataDir}`;
  const profiles = allNormalized([settings.userDataDir, input.userDataDirReal]);
  if (profiles === null) return { ok: false, reason: "profile-path", refused: profileArg };
  const defaults = allNormalized(input.chromeDefaultDirsReal);
  if (defaults === null || defaults.length === 0) {
    return { ok: false, reason: "default-dirs-unknown", refused: profileArg };
  }
  if (profiles.some((profile) => defaults.some((dir) => within(profile, dir)))) {
    return { ok: false, reason: "default-profile", refused: profileArg };
  }
  for (const arg of settings.extraArgs) {
    if (forbiddenSwitch(arg)) return { ok: false, reason: "forbidden-switch", refused: arg };
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
      ...settings.extraArgs,
    ],
  };
}
