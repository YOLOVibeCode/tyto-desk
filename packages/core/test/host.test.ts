import { describe, expect, it } from "vitest";
import { DESK_EXTENSION_ORIGIN, hostStateFor, startHost } from "../src/index.ts";
import { FakeClock, FakeDaemonDialer, FakeDetachedSpawner } from "../src/testing/index.ts";

const daemon = { file: "/Users/alex/.desk/app/0.3.0/node/desk-node", args: ["/Users/alex/.desk/app/0.3.0/desk.mjs", "ptyd"], env: { HOME: "/Users/alex" } };
const link = { name: "the daemon's socket" };

function setup(results: ConstructorParameters<typeof FakeDaemonDialer<typeof link>>[0]) {
  const dialer = new FakeDaemonDialer<typeof link>(results);
  const spawner = new FakeDetachedSpawner();
  const clock = new FakeClock({ auto: true });
  let commands = 0;
  const host = (origin: string | undefined) =>
    startHost({
      origin,
      dialer,
      spawner,
      clock,
      daemonCommand: async () => {
        commands += 1;
        return daemon;
      },
    });
  return { dialer, spawner, clock, host, commands: () => commands };
}

describe("the native host", () => {
  it.each([
    ["another extension", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"],
    ["a web page", "https://example.test/"],
    ["no origin at all", undefined],
    ["the Desk origin with more after it", `${DESK_EXTENSION_ORIGIN}x`],
  ])("the host exits without contacting the daemon when the caller origin is not the Desk extension (%s)", async (_label, origin) => {
    const { dialer, spawner, host, commands } = setup([{ ok: true, link }]);

    expect(await host(origin)).toEqual({ ok: false, reason: "foreign-origin" });
    expect(dialer.connects).toBe(0);
    expect(spawner.started).toEqual([]);
    expect(commands()).toBe(0);
  });

  it("the host relays to a daemon that answers without starting another", async () => {
    const { spawner, host } = setup([{ ok: true, link }]);

    expect(await host(DESK_EXTENSION_ORIGIN)).toEqual({ ok: true, link, started: false });
    expect(spawner.started).toEqual([]);
  });

  it("the host starts the daemon detached when the socket is dead and retries for 3 s", async () => {
    const { dialer, spawner, clock, host } = setup([{ ok: false, reason: "dead" }]);
    const begun = clock.now();
    let startedAt = 0;
    spawner.onStart = () => {
      startedAt = clock.now();
      dialer.answer({ ok: false, reason: "dead" });
    };

    const gaveUp = await host(DESK_EXTENSION_ORIGIN);

    expect(spawner.started).toEqual([daemon]);
    expect(gaveUp).toEqual({ ok: false, reason: "daemon-unreachable" });
    expect(dialer.connects).toBeGreaterThan(3);
    expect(clock.now() - startedAt).toBeGreaterThanOrEqual(3_000);
    expect(clock.now() - begun).toBeLessThan(4_000);
  });

  it("the host relays once the daemon it started begins to listen", async () => {
    const { dialer, spawner, host } = setup([{ ok: false, reason: "dead" }]);
    spawner.onStart = () => dialer.answer({ ok: true, link });

    expect(await host(DESK_EXTENSION_ORIGIN)).toEqual({ ok: true, link, started: true });
    expect(spawner.started).toHaveLength(1);
  });

  it("the host starts no daemon when the socket fails for another reason", async () => {
    const { spawner, host } = setup([{ ok: false, reason: "failed" }]);

    expect(await host(DESK_EXTENSION_ORIGIN)).toEqual({ ok: false, reason: "daemon-unreachable" });
    expect(spawner.started).toEqual([]);
  });

  it("the host starts no daemon when there is no installed version to start it from", async () => {
    const dialer = new FakeDaemonDialer<typeof link>([{ ok: false, reason: "dead" }]);
    const spawner = new FakeDetachedSpawner();

    const result = await startHost({ origin: DESK_EXTENSION_ORIGIN, dialer, spawner, clock: new FakeClock({ auto: true }), daemonCommand: async () => null });

    expect(result).toEqual({ ok: false, reason: "no-current-version" });
    expect(spawner.started).toEqual([]);
  });

  it.each([
    ["no-current-version", { type: "host", state: "install-damaged" }],
    ["daemon-unreachable", { type: "host", state: "no-daemon" }],
    ["foreign-origin", null],
  ] as const)("a host that could not start for %s tells the panel %j before it ends", (reason, message) => {
    expect(hostStateFor(reason)).toEqual(message);
  });
});
