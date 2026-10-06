import { describe, expect, it } from "vitest";
import { chromeArgs, chromeDefaultDirs, newDeskConfig, type DeskConfig } from "../src/index.ts";

const chrome = newDeskConfig({ home: "/Users/alex", platform: "darwin", chromePort: 9417, gatewayPort: 9583 }).chrome;
const chromeDefault = "/Users/alex/Library/Application Support/Google/Chrome";

function args(overrides: Partial<DeskConfig["chrome"]> = {}, userDataDirReal = chrome.userDataDir) {
  return chromeArgs({
    chrome: { ...chrome, ...overrides },
    userDataDirReal,
    chromeDefaultDirsReal: chromeDefaultDirs("/Users/alex", "darwin"),
  });
}

/** Chrome's stable, Beta, Dev and Canary default directories under a macOS home. */
function macChannels(home: string): string[] {
  return ["Chrome", "Chrome Beta", "Chrome Dev", "Chrome Canary"].map(
    (channel) => `${home}/Library/Application Support/Google/${channel}`,
  );
}

describe("chromeArgs", () => {
  it("chromeArgs puts the stored port and the user-data-dir first", () => {
    const result = args({ extraArgs: ["--lang=en-US"] });

    expect(result.ok && result.args.slice(0, 2)).toEqual([
      "--remote-debugging-port=9417",
      "--user-data-dir=/Users/alex/Library/Application Support/Desk/Chrome",
    ]);
  });

  it.each([[[]], [["--lang=en-US"]], [["--force-dark-mode", "https://example.test/"]]])(
    "chromeArgs adds --restore-last-session and --hide-crash-restore-bubble to every launch (extraArgs %j)",
    (extraArgs) => {
      const result = args({ extraArgs });

      expect(result.ok && result.args).toEqual(
        expect.arrayContaining(["--restore-last-session", "--hide-crash-restore-bubble"]),
      );
    },
  );

  it("chromeArgs turns off the first-run and default-browser prompts", () => {
    expect(args()).toEqual({
      ok: true,
      args: [
        "--remote-debugging-port=9417",
        "--user-data-dir=/Users/alex/Library/Application Support/Desk/Chrome",
        "--no-first-run",
        "--no-default-browser-check",
        "--restore-last-session",
        "--hide-crash-restore-bubble",
      ],
    });
  });

  it("chromeArgs passes other extraArgs after its own, in order", () => {
    const result = args({ extraArgs: ["--lang=en-US", "--force-dark-mode"] });

    expect(result.ok && result.args.slice(-2)).toEqual(["--lang=en-US", "--force-dark-mode"]);
  });

  it.each([
    "--remote-debugging-pipe",
    "--remote-debugging-port=0",
    "--enable-automation",
    "--headless",
    "--headless=new",
    "--headless=old",
    "-headless",
    "--remote-allow-origins=*",
    "--remote-debugging-address=0.0.0.0",
    "--load-extension=/tmp/extension",
    "--use-mock-keychain",
    "--no-sandbox",
    "-no-sandbox",
    "--disable-web-security",
    `--user-data-dir=${chromeDefault}`,
    "--enable-blink-features=AutomationControlled",
    "--enable-blink-features=CSSAnchorPositioning,automationcontrolled",
    "--remote-debugging-io-pipes=3,4",
    "--disable-gpu-sandbox",
    "--disable-setuid-sandbox",
    "--no-zygote",
    "--disable-site-isolation-trials",
    "--password-store=basic",
    "--use-fake-ui-for-media-stream",
  ])("chromeArgs refuses %s, also from config extraArgs", (flag) => {
    expect(args({ extraArgs: ["--lang=en-US", flag] })).toMatchObject({ ok: false, refused: flag });
  });

  it.each(["--enable-blink-features=CSSAnchorPositioning", "--password-store=gnome-libsecret"])(
    "chromeArgs passes %s, whose value is not a forbidden one",
    (flag) => {
      expect(args({ extraArgs: [flag] }).ok).toBe(true);
    },
  );

  it.each([0, 9222, 9229, 9399, 9900])("chromeArgs refuses a stored port of %i", (port) => {
    expect(args({ port })).toEqual({
      ok: false,
      reason: "port-out-of-range",
      refused: `--remote-debugging-port=${port}`,
    });
  });

  it.each(["--remote-debugging-port=9555", "--user-data-dir=/Users/alex/Other"])(
    "chromeArgs refuses %s from extraArgs, because Desk owns the port and the profile",
    (flag) => {
      expect(args({ extraArgs: [flag] })).toEqual({ ok: false, reason: "forbidden-switch", refused: flag });
    },
  );

  it.each([
    ["Chrome's default directory itself", chromeDefault],
    ["a profile inside it", `${chromeDefault}/Desk`],
    ["the same directory in other letter case", "/Users/alex/Library/Application Support/google/chrome/Profile 1"],
    ["its spelling through the Data volume", `/System/Volumes/Data${chromeDefault}/Default`],
    ["Chrome Canary's default directory", "/Users/alex/Library/Application Support/Google/Chrome Canary"],
    ["a path whose .. segment leads into it", "/Users/alex/Library/Application Support/Google/x/../Chrome"],
    ["a path with a . segment", "/Users/alex/Library/Application Support/Google/./Chrome"],
    ["a path with repeated slashes", "/Users/alex//Library/Application Support/Google/Chrome/Default"],
  ])("chromeArgs refuses a user-data-dir whose real path is under Chrome's default directory (%s)", (_label, real) => {
    expect(args({ userDataDir: "/Users/alex/DeskProfile" }, real)).toEqual({
      ok: false,
      reason: "default-profile",
      refused: "--user-data-dir=/Users/alex/DeskProfile",
    });
  });

  it.each([
    ["Chrome's default directory", chromeDefault],
    ["its spelling through the Data volume", `/System/Volumes/Data${chromeDefault}`],
  ])("chromeArgs refuses a configured user-data-dir under Chrome's default directory, whatever its real path (%s)", (_label, configured) => {
    expect(args({ userDataDir: configured }, "/Users/alex/DeskProfile")).toEqual({
      ok: false,
      reason: "default-profile",
      refused: `--user-data-dir=${configured}`,
    });
  });

  it.each([
    ["an empty configured path", "", "/Users/alex/DeskProfile"],
    ["a relative configured path", "DeskProfile", "/Users/alex/DeskProfile"],
    ["an empty real path", "/Users/alex/DeskProfile", ""],
    ["a relative real path", "/Users/alex/DeskProfile", "DeskProfile"],
    ["a NUL in the path", "/Users/alex/Desk\0Profile", "/Users/alex/DeskProfile"],
  ])("chromeArgs refuses a user-data-dir that is not a plain absolute path (%s)", (_label, configured, real) => {
    expect(args({ userDataDir: configured }, real)).toEqual({
      ok: false,
      reason: "profile-path",
      refused: `--user-data-dir=${configured}`,
    });
  });

  it.each([
    ["no directories", []],
    ["a relative directory", ["Library/Application Support/Google/Chrome"]],
  ])("chromeArgs refuses to judge a user-data-dir without Chrome's default directories (%s)", (_label, dirs) => {
    expect(chromeArgs({ chrome, userDataDirReal: chrome.userDataDir, chromeDefaultDirsReal: dirs })).toEqual({
      ok: false,
      reason: "default-dirs-unknown",
      refused: `--user-data-dir=${chrome.userDataDir}`,
    });
  });

  it("chromeArgs accepts a sibling of Chrome's default directory", () => {
    const sibling = "/Users/alex/Library/Application Support/Google/Chrome Desk";

    expect(args({ userDataDir: sibling }, sibling).ok).toBe(true);
  });

  it.each([
    ["darwin", "/Users/alex", [...macChannels("/Users/alex"), ...macChannels("/System/Volumes/Data/Users/alex")]],
    ["darwin", "/Users/alex/", [...macChannels("/Users/alex"), ...macChannels("/System/Volumes/Data/Users/alex")]],
    [
      "darwin",
      "/System/Volumes/Data/Users/alex",
      [...macChannels("/Users/alex"), ...macChannels("/System/Volumes/Data/Users/alex")],
    ],
    [
      "linux",
      "/home/lab",
      ["google-chrome", "google-chrome-beta", "google-chrome-unstable", "google-chrome-canary"].map(
        (channel) => `/home/lab/.config/${channel}`,
      ),
    ],
    ["win32", "C:\\Users\\alex", []],
  ])("Chrome's default user-data directories on %s for the home %s", (platform, home, dirs) => {
    expect(chromeDefaultDirs(home, platform)).toEqual(dirs);
  });
});
