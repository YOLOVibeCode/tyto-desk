import { describe, expect, it } from "vitest";
import { NodeShellProbe } from "../src/index.ts";
import { fakeExecutable } from "../../../test/fixtures/fake-exec.ts";

describe("a pane shell's terminal and children (docs/IMPLEMENTATION.md §7.4)", () => {
  it("NodeShellProbe reads a macOS terminal from ps and names it under /dev", async () => {
    const ps = await fakeExecutable("ps", [{ match: ["-o", "tty="], stdout: "ttys004\n" }]);

    expect(await new NodeShellProbe({ ps: ps.path, procRoot: null }).ttyOf(4242)).toBe("/dev/ttys004");
    expect((await ps.calls())[0]?.argv).toEqual(["-o", "tty=", "-p", "4242"]);
  });

  it("NodeShellProbe gives no terminal for a process without one", async () => {
    const ps = await fakeExecutable("ps", [{ match: ["-o", "tty="], stdout: "??\n" }]);

    expect(await new NodeShellProbe({ ps: ps.path, procRoot: null }).ttyOf(4242)).toBeNull();
  });

  it("NodeShellProbe tells a shell with a child from one without", async () => {
    const ps = await fakeExecutable("ps", [{ match: ["-axo"], stdout: "    1     0\n 4242     1\n 4300  4242\n 4301     1\n" }]);
    const probe = new NodeShellProbe({ ps: ps.path, procRoot: null });

    expect(await probe.hasChildren(4242)).toBe(true);
    expect(await probe.hasChildren(4300)).toBe(false);
  });
});
