import { describe, expect, it } from "vitest";
import { classifyLaunch, listenerIsDesk, singletonState, staleLockToClear, type LaunchFacts } from "../src/index.ts";

const DIR = "/Users/alex/Library/Application Support/Desk/Chrome";
const APP = "/Applications/Google Chrome.app";
const EXE = `${APP}/Contents/MacOS/Google Chrome`;
const ARGS = `${EXE} --remote-debugging-port=9417 --user-data-dir=${DIR} --no-first-run`;

describe("classifying the Desk Chrome at launch (docs/IMPLEMENTATION.md §6.1 step 4)", () => {
  it.each<[LaunchFacts["singleton"], string, LaunchFacts, ReturnType<typeof classifyLaunch>]>([
    ["none", "free", { singleton: "none", answers: false, busy: false, listener: "unverifiable" }, "launch"],
    ["dead", "free", { singleton: "dead", answers: false, busy: false, listener: "unverifiable" }, "launch"],
    ["none", "busy", { singleton: "none", answers: false, busy: true, listener: "unverifiable" }, "move-port"],
    ["dead", "answering", { singleton: "dead", answers: true, busy: true, listener: "other" }, "move-port"],
    ["alive", "answering, Desk's listener", { singleton: "alive", answers: true, busy: true, listener: "desk" }, "reuse"],
    ["alive", "answering, another listener", { singleton: "alive", answers: true, busy: true, listener: "other" }, "foreign"],
    ["alive", "silent", { singleton: "alive", answers: false, busy: false, listener: "unverifiable" }, "wait"],
    ["alive", "silent but held", { singleton: "alive", answers: false, busy: true, listener: "other" }, "wait"],
  ])("classification decides %s singleton, %s port", (_singleton, _port, facts, decision) => {
    expect(classifyLaunch(facts)).toBe(decision);
  });

  it("classification treats an unverifiable listener as another program", () => {
    expect(classifyLaunch({ singleton: "alive", answers: true, busy: true, listener: "unverifiable" })).toBe("foreign");
  });
});

describe("whose listener holds the Desk port", () => {
  const desk = { singletonPid: 4242, listenerPid: 4242, image: { exe: EXE, args: ARGS }, appRoot: APP, userDataDir: DIR };

  it("a listener is the Desk Chrome when it is the singleton's process, runs the configured app, and has the Desk profile", () => {
    expect(listenerIsDesk(desk)).toBe("desk");
  });

  it.each([
    ["another pid", { listenerPid: 5151 }],
    ["another executable", { image: { exe: "/opt/homebrew/bin/node", args: `node --user-data-dir=${DIR}` } }],
    ["an executable whose path only starts like the app", { image: { exe: `${APP} Beta/Contents/MacOS/Google Chrome`, args: ARGS } }],
    ["another profile", { image: { exe: EXE, args: `${EXE} --user-data-dir=${DIR}2` } }],
  ])("a listener with %s is another program", (_, change) => {
    expect(listenerIsDesk({ ...desk, ...change })).toBe("other");
  });

  it.each([
    ["no listener pid", { listenerPid: null }],
    ["no image", { image: null }],
  ])("a listener with %s cannot be verified", (_, change) => {
    expect(listenerIsDesk({ ...desk, ...change })).toBe("unverifiable");
  });
});

describe("the Desk profile's SingletonLock", () => {
  it.each<[string, Parameters<typeof singletonState>[0], ReturnType<typeof singletonState>]>([
    ["no lock", { lock: null, alive: false, users: [] }, "none"],
    ["a dead pid", { lock: { host: "alex-mac", pid: 4242 }, alive: false, users: [] }, "dead"],
    ["a live pid that uses the profile", { lock: { host: "alex-mac", pid: 4242 }, alive: true, users: [4242] }, "alive"],
    ["a live pid that does not use the profile (a reused pid)", { lock: { host: "alex-mac", pid: 4242 }, alive: true, users: [] }, "dead"],
    ["a live pid and an unreadable process list", { lock: { host: "alex-mac", pid: 4242 }, alive: true, users: null }, "alive"],
  ])("a singleton with %s is %s", (_, input, state) => {
    expect(singletonState(input)).toBe(state);
  });

  it("a dead lock naming another host is cleared only when no process uses the profile", () => {
    const lock = { host: "old-name.local", pid: 4242 };

    expect(staleLockToClear({ lock, host: "alex-mac", state: "dead", users: [] })).toBe(true);
    expect(staleLockToClear({ lock, host: "alex-mac", state: "dead", users: [77] })).toBe(false);
    expect(staleLockToClear({ lock, host: "alex-mac", state: "dead", users: null })).toBe(false);
    expect(staleLockToClear({ lock, host: "old-name.local", state: "dead", users: [] })).toBe(false);
    expect(staleLockToClear({ lock, host: "alex-mac", state: "alive", users: [4242] })).toBe(false);
  });
});
