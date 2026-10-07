import { describe, expect, it } from "vitest";
import { runWatch } from "../src/index.ts";
import { FakeGuardedEndpoint, FakeInstanceLock } from "../src/testing/index.ts";

/** A stop signal the test fires, as SIGTERM or SIGHUP does for the process. */
function stopper() {
  let stop: () => void = () => undefined;
  const until = new Promise<void>((resolve) => {
    stop = resolve;
  });
  return { until, stop };
}

describe("desk watch (docs/IMPLEMENTATION.md §6.4; slice 4a serves only the guarded endpoint)", () => {
  it("desk watch exits 0 on SIGTERM after closing the guarded endpoint and releasing its lock", async () => {
    const log: string[] = [];
    const lock = new FakeInstanceLock();
    const endpoint = new FakeGuardedEndpoint(log);
    const { until, stop } = stopper();

    const running = runWatch({ lock, endpoint }, until);
    await endpoint.listening;
    log.push("SIGTERM");
    stop();

    expect(await running).toBe(0);
    expect(log).toEqual(["endpoint.listen", "SIGTERM", "endpoint.close"]);
    expect(lock.acquired).toEqual(["watch"]);
    expect(lock.released).toEqual(["watch"]);
  });

  it("a second desk watch exits 0 at once while a live watch holds the lock, and serves nothing", async () => {
    const lock = new FakeInstanceLock();
    lock.heldBy.set("watch", 5151);
    const endpoint = new FakeGuardedEndpoint();

    expect(await runWatch({ lock, endpoint }, new Promise(() => undefined))).toBe(0);
    expect(endpoint.listens).toBe(0);
  });

  it("desk watch exits 75 and releases its lock when the guarded port is taken", async () => {
    const lock = new FakeInstanceLock();
    const endpoint = new FakeGuardedEndpoint();
    endpoint.portTaken = true;

    expect(await runWatch({ lock, endpoint }, new Promise(() => undefined))).toBe(75);
    expect(lock.released).toEqual(["watch"]);
  });
});
