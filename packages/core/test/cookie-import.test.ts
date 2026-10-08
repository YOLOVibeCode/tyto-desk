import { describe, expect, it } from "vitest";
import { importCookies, type Cookie } from "../src/index.ts";
import {
  FakeChromeProfile,
  FakeClock,
  FakeCookieBrowser,
  FakeDeskBrowser,
  FakeDevToolsPortFile,
  FakeListenerInfo,
  MemoryLogSink,
  MemoryOperatorOutput,
  ScriptedPicker,
  ScriptedPrompter,
} from "../src/testing/index.ts";

const APP = "/Applications/Google Chrome.app";
const EXE = `${APP}/Contents/MacOS/Google Chrome`;
const DESK_UD = "/Users/alex/Library/Application Support/Tyto Desk/Chrome";
const MAIN_PORT = 50123;
const DESK_PORT = 9417;
const MAIN_WS = `ws://127.0.0.1:${MAIN_PORT}/devtools/browser/main-uuid`;
const DESK_WS = `ws://127.0.0.1:${DESK_PORT}/devtools/browser/desk-uuid`;
const NOW = Date.parse("2026-10-08T12:00:00Z");
const SECRET = "s3cr3t-cookie-value";

const cookie = (domain: string, name: string, extra: Partial<Cookie> = {}): Cookie => ({
  name,
  value: SECRET,
  domain,
  path: "/",
  expires: NOW / 1000 + 86_400,
  secure: true,
  httpOnly: true,
  sameSite: "Lax",
  ...extra,
});

function setup(options: { answers?: (boolean | "no-tty")[]; picks?: (readonly number[] | "no-tty")[]; domains?: string[] } = {}) {
  const prompter = new ScriptedPrompter(options.answers ?? [true, true]);
  const picker = new ScriptedPicker(options.picks ?? [[0]]);
  const out = new MemoryOperatorOutput();
  const portFile = new FakeDevToolsPortFile({ port: MAIN_PORT, path: "/devtools/browser/main-uuid" });
  const mainProfile = new FakeChromeProfile();
  mainProfile.lock = { host: "mac", pid: 501 };
  const deskProfile = new FakeChromeProfile();
  deskProfile.lock = { host: "mac", pid: 777 };
  const listeners = new FakeListenerInfo();
  listeners.listeners.set(MAIN_PORT, 501);
  listeners.listeners.set(DESK_PORT, 777);
  listeners.images.set(501, { exe: EXE, args: `${EXE} --remote-debugging-port=0` });
  listeners.images.set(777, { exe: EXE, args: `${EXE} --user-data-dir=${DESK_UD} --remote-debugging-port=${DESK_PORT}` });
  const browsers = new FakeCookieBrowser();
  browsers.jars.set(MAIN_WS, [
    cookie(".example.test", "session"),
    cookie("app.example.test", "prefs", { httpOnly: false, sameSite: "Strict", partitionKey: { topLevelSite: "https://example.test", hasCrossSiteAncestor: false } }),
    cookie(".other.test", "id"),
    cookie(".google.co.uk", "NID"),
    cookie(".example.test", "SAPISID"),
    cookie(".expired.test", "old", { expires: NOW / 1000 - 10 }),
  ]);
  const desk = new FakeDeskBrowser({ port: DESK_PORT, wsUrl: DESK_WS });
  const clock = new FakeClock({ start: NOW, auto: true });
  const audit = new MemoryLogSink();
  // The main Chrome's remote debugging goes off as soon as it is checked, unless a test keeps it on.
  mainProfile.localState = { devtools: { remote_debugging: { "user-enabled": false } } };
  const run = () =>
    importCookies(
      { prompter, picker, out, portFile, mainProfile, deskProfile, listeners, browsers, desk, clock, audit },
      { appRoot: APP, deskUserDataDir: DESK_UD, ...(options.domains === undefined ? {} : { domains: options.domains }) },
    );
  return { prompter, picker, out, portFile, mainProfile, deskProfile, listeners, browsers, desk, clock, audit, run };
}

describe("desk import cookies (docs/IMPLEMENTATION.md §14)", () => {
  it("cookie import moves the chosen domain's cookies from the main Chrome into the Desk Chrome", async () => {
    const desk = setup();

    const result = await desk.run();

    expect(result.code).toBe(0);
    expect(desk.browsers.written.get(DESK_WS)?.map((c) => c.name)).toEqual(["session", "prefs"]);
    expect(desk.browsers.closed).toContain(MAIN_WS);
  });

  it("cookie import refuses to run without an interactive TTY", async () => {
    const desk = setup({ answers: ["no-tty"] });

    const result = await desk.run();

    expect(result.code).toBe(64);
    expect(desk.browsers.connects).toEqual([]);
  });

  it("cookie import selects no domain unless named", async () => {
    const desk = setup({ picks: [[]] });

    const result = await desk.run();

    expect(desk.picker.shown[0]?.options).toEqual(["example.test (2 cookies)", "other.test (1 cookie)"]);
    expect(result.code).toBe(77);
    expect(desk.browsers.written.size).toBe(0);
  });

  it("naming domains with --domains skips the picker", async () => {
    const desk = setup({ domains: ["other.test"] });

    await desk.run();

    expect(desk.picker.shown).toEqual([]);
    expect(desk.browsers.written.get(DESK_WS)?.map((c) => c.name)).toEqual(["id"]);
  });

  it("cookie import never moves Google account cookies from youtube.com or google.co.uk", async () => {
    const desk = setup({ picks: [[0, 1]] });

    await desk.run();

    expect(desk.browsers.written.get(DESK_WS)?.map((c) => c.name)).not.toContain("NID");
    expect(desk.picker.shown[0]?.options.join(" ")).not.toContain("google");
  });

  it("cookie import drops Google account cookies by name on any domain", async () => {
    const desk = setup({ picks: [[0, 1]] });

    await desk.run();

    expect(desk.browsers.written.get(DESK_WS)?.map((c) => c.name)).toEqual(["session", "prefs", "id"]);
  });

  it("cookie import never prints a cookie value", async () => {
    const desk = setup();

    await desk.run();

    expect(JSON.stringify([desk.out.lines, desk.picker.shown, desk.prompter.asked, desk.audit.events])).not.toContain(SECRET);
  });

  it("cookie import refuses a main-Chrome port whose listener is not the main Chrome", async () => {
    const desk = setup();
    desk.listeners.images.set(501, { exe: EXE, args: `${EXE} --user-data-dir=/tmp/other` });

    const result = await desk.run();

    expect(result.code).toBe(75);
    expect(desk.browsers.connects).toEqual([]);
  });

  it("cookie import refuses a main-Chrome port another process took, even one that looks like Chrome", async () => {
    const desk = setup();
    desk.listeners.listeners.set(MAIN_PORT, 4242);
    desk.listeners.images.set(4242, { exe: EXE, args: `${EXE} --remote-debugging-port=0` });

    expect((await desk.run()).code).toBe(75);
  });

  it("cookie import says how to turn remote debugging on when the main Chrome has it off", async () => {
    const desk = setup();
    desk.portFile.value = null;

    const result = await desk.run();

    expect(result.code).toBe(75);
    expect(result.message).toContain("chrome://inspect/#remote-debugging");
  });

  it("cookie import refuses a Desk port whose listener is not the Desk Chrome", async () => {
    const desk = setup();
    desk.listeners.images.set(777, { exe: EXE, args: `${EXE} --user-data-dir=/tmp/elsewhere` });

    const result = await desk.run();

    expect(result.code).toBe(75);
    expect(desk.browsers.written.size).toBe(0);
  });

  it("cookie import waits up to 60 s for Allow", async () => {
    const desk = setup();
    desk.browsers.refusing.add(MAIN_WS);

    const result = await desk.run();

    expect(desk.browsers.connects[0]).toEqual({ wsUrl: MAIN_WS, timeoutMs: 60_000 });
    expect(result.code).toBe(75);
  });

  it("cookie import keeps name, domain, path, expiry, secure, httpOnly, sameSite and partition key", async () => {
    const desk = setup();

    await desk.run();

    const moved = desk.browsers.written.get(DESK_WS)?.find((c) => c.name === "prefs");
    expect(moved).toEqual(desk.browsers.jars.get(MAIN_WS)?.find((c) => c.name === "prefs"));
  });

  it("declining writes nothing and exits 77", async () => {
    const desk = setup({ answers: [true, false] });

    const result = await desk.run();

    expect(result.code).toBe(77);
    expect(desk.browsers.written.size).toBe(0);
    expect(desk.desk.ensured).toBe(0);
  });

  it("cookie import ends by checking that the main Chrome's remote debugging is off and says how to turn it off", async () => {
    const desk = setup();
    desk.mainProfile.localState = { devtools: { remote_debugging: { "user-enabled": true } } };
    let checks = 0;
    const original = desk.mainProfile.localStatePref.bind(desk.mainProfile);
    desk.mainProfile.localStatePref = async (path) => {
      checks += 1;
      if (checks === 3) desk.mainProfile.localState = { devtools: { remote_debugging: { "user-enabled": false } } };
      return original(path);
    };

    const result = await desk.run();

    expect(result.code).toBe(0);
    expect(desk.out.lines.join("\n")).toContain("turn off remote debugging");
    expect(checks).toBeGreaterThanOrEqual(3);
  });

  it("every consent operation writes one audit line with counts and exit code only", async () => {
    const desk = setup();

    await desk.run();

    expect(desk.audit.events).toEqual([{ event: "consent", op: "import-cookies", read: 6, eligible: 3, chosen: 2, set: 2, failed: 0, code: 0 }]);
  });
});
