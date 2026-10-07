import { describe, expect, it } from "vitest";
import { newDeskConfig, newGuardedPort } from "../src/index.ts";
import {
  FakeClock,
  FakeDetachedSpawner,
  FakeInstanceLock,
  FakePortProbe,
  FakeProcessSignals,
  MemoryConfigStore,
  MemoryTextFiles,
  SeqRandom,
} from "../src/testing/index.ts";

const deskHome = "/Users/alex/.desk";
const version = "0.3.1-dev.slice-3b+a1b2c3d";
const config = newDeskConfig({ home: "/Users/alex", platform: "darwin", chromePort: 9417, gatewayPort: 9583 });
const watchCommand = { file: "/Users/alex/.desk/app/x/Desk Terminal", args: ["desk.mjs", "watch"], env: { HOME: "/Users/alex" } };

function setup(saved: typeof config | null = config) {
  const store = new MemoryConfigStore(saved);
  const files = new MemoryTextFiles({});
  const lock = new FakeInstanceLock();
  const signals = new FakeProcessSignals();
  const spawner = new FakeDetachedSpawner();
  const clock = new FakeClock({ auto: true });
  const run = () =>
    newGuardedPort(
      { config: store, probe: new FakePortProbe(), random: new SeqRandom([0]), files, lock, signals, spawner, clock },
      { deskHome, version, watchCommand },
    );
  return { store, files, lock, signals, spawner, clock, run };
}

describe("desk config new-port (docs/IMPLEMENTATION.md §6.4, SPEC §4)", () => {
  it("desk config new-port picks a new guarded port and warns that running tmux sessions keep the old URL", async () => {
    const desk = setup();

    const result = await desk.run();
    const port = (await desk.store.load())?.gateway.port;

    expect(port).not.toBe(9583);
    expect(port).not.toBe(9417);
    expect(result).toEqual({
      code: 0,
      message:
        `The guarded endpoint moved from port 9583 to port ${port}. agent-browser follows it now; running tmux sessions keep ` +
        `DESK_CDP_URL=http://127.0.0.1:9583 until you restart them, and new panes get http://127.0.0.1:${port}`,
    });
  });

  it("desk config new-port rewrites agent-browser.json, so agent-browser follows the new port", async () => {
    const desk = setup();

    await desk.run();
    const port = (await desk.store.load())?.gateway.port;

    expect(JSON.parse((await desk.files.read(`${deskHome}/agent-browser.json`)) ?? "{}")).toMatchObject({ cdp: `http://127.0.0.1:${port}` });
  });

  it("desk config new-port replaces a running desk watch, so the guarded endpoint moves now", async () => {
    const desk = setup();
    desk.lock.holders.set("watch", { pid: 6200, build: version });
    desk.signals.onTerminate = () => desk.lock.holders.delete("watch");

    await desk.run();

    expect(desk.signals.terminated).toEqual([6200]);
    expect(desk.spawner.started).toEqual([watchCommand]);
  });

  it("desk config new-port starts no desk watch when none runs", async () => {
    const desk = setup();

    await desk.run();

    expect(desk.spawner.started).toEqual([]);
  });

  it("desk config new-port holds run/launch.lock, so it never races a starting desk", async () => {
    const desk = setup();
    desk.lock.heldBy.set("launch", 777);

    const result = await desk.run();

    expect(result).toMatchObject({ code: 75 });
    expect((await desk.store.load())?.gateway.port).toBe(9583);
  });

  it("desk config new-port exits 65 before the first desk made a config", async () => {
    const desk = setup(null);

    const result = await desk.run();

    expect(result).toEqual({ code: 65, message: "Desk has no config yet; run desk first" });
  });
});
