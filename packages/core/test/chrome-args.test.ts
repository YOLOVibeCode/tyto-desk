import { describe, expect, it } from "vitest";
import { chromeArgs, chromeDefaultDirs, newDeskConfig, type DeskConfig } from "../src/index.ts";

const chrome = newDeskConfig({ home: "/Users/alex", platform: "darwin", chromePort: 9417, gatewayPort: 9583 }).chrome;
const chromeDefault = "/Users/alex/Library/Application Support/Google/Chrome";

function args(overrides: Partial<DeskConfig["chrome"]> = {}, userDataDirReal = chrome.userDataDir) {
  return chromeArgs({
    chrome: { ...chrome, ...overrides },
    userDataDirReal,
    chromeDefaultDirsReal: [chromeDefault],
  });
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
  ])("chromeArgs refuses %s, also from config extraArgs", (flag) => {
    expect(args({ extraArgs: ["--lang=en-US", flag] })).toMatchObject({ ok: false, refused: flag });
  });

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
    ["a symlink that resolves into it", `${chromeDefault}/Default`],
  ])("chromeArgs refuses a user-data-dir whose real path is under Chrome's default directory (%s)", (_label, real) => {
    expect(args({ userDataDir: "/Users/alex/DeskProfile" }, real)).toEqual({
      ok: false,
      reason: "default-profile",
      refused: "--user-data-dir=/Users/alex/DeskProfile",
    });
  });

  it("chromeArgs accepts a sibling of Chrome's default directory", () => {
    const sibling = "/Users/alex/Library/Application Support/Google/Chrome Desk";

    expect(args({ userDataDir: sibling }, sibling).ok).toBe(true);
  });

  it.each([
    ["darwin", "/Users/alex", ["/Users/alex/Library/Application Support/Google/Chrome"]],
    ["linux", "/home/lab", ["/home/lab/.config/google-chrome"]],
  ])("Chrome's default user-data directory on %s", (platform, home, dirs) => {
    expect(chromeDefaultDirs(home, platform)).toEqual(dirs);
  });
});
