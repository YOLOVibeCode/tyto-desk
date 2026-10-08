import { describe, expect, it } from "vitest";
import { NodeTmux, findTmux } from "../src/index.ts";
import { fakeExecutable } from "../../../test/fixtures/fake-exec.ts";

const LISTING =
  "update-environment[0] DISPLAY\nupdate-environment[1] SSH_AUTH_SOCK\nupdate-environment[13] AGENT_BROWSER_CONFIG\nupdate-environment[14] DESK_PANE\n";

describe("NodeTmux", () => {
  it("Tmux reads the running server's update-environment names with show-options -g", async () => {
    const tmux = await fakeExecutable("tmux", [{ match: ["show-options", "-g", "update-environment"], stdout: LISTING }]);

    const names = await new NodeTmux(tmux.path, { HOME: "/Users/alex", PATH: "/usr/bin:/bin" }).updateEnvironment();

    expect(names).toEqual(["DISPLAY", "SSH_AUTH_SOCK", "AGENT_BROWSER_CONFIG", "DESK_PANE"]);
    expect((await tmux.calls()).map((call) => call.argv)).toEqual([["show-options", "-g", "update-environment"]]);
  });

  it("Tmux reports no server and no names when tmux says no server is running", async () => {
    const tmux = await fakeExecutable("tmux", [{ match: ["show-options"], stderr: "no server running on /tmp/tmux-501/default\n", exit: 1 }]);
    const adapter = new NodeTmux(tmux.path, { HOME: "/Users/alex", PATH: "/usr/bin:/bin" });

    expect(await adapter.updateEnvironment()).toBeNull();
    expect(await adapter.serverRunning()).toBe(false);
  });

  it("Tmux runs with an explicit environment that never carries TMUX, and never runs show-environment", async () => {
    const tmux = await fakeExecutable("tmux", [{ match: ["show-options"], stdout: LISTING }]);
    const adapter = new NodeTmux(tmux.path, { HOME: "/Users/alex", PATH: "/usr/bin:/bin", TMUX: "/tmp/tmux-501/default,1,0", SECRET: "x" });

    expect(await adapter.serverRunning()).toBe(true);
    const [call] = await tmux.calls();
    expect(call?.env.TMUX).toBeUndefined();
    expect(call?.env.SECRET).toBeUndefined();
    expect(call?.env.HOME).toBe("/Users/alex");
    expect((await tmux.calls()).flatMap((c) => c.argv)).not.toContain("show-environment");
  });

  it("Tmux never runs show-environment", async () => {
    const tmux = await fakeExecutable("tmux", [{ match: ["show-options"], stdout: LISTING }]);
    const adapter = new NodeTmux(tmux.path, { HOME: "/Users/alex", PATH: "/usr/bin:/bin" });

    await adapter.serverRunning();
    await adapter.updateEnvironment();

    expect((await tmux.calls()).filter((call) => call.argv.includes("show-environment"))).toEqual([]);
  });

  it("Tmux appends names to the running server's update-environment as one argv entry", async () => {
    const tmux = await fakeExecutable("tmux", [{ match: ["set-option"], stdout: "" }]);

    const ok = await new NodeTmux(tmux.path, { HOME: "/Users/alex", PATH: "/usr/bin:/bin" }).appendUpdateEnvironment(["AGENT_BROWSER_CONFIG", "DESK_PANE"]);

    expect(ok).toBe(true);
    expect((await tmux.calls()).map((call) => call.argv)).toEqual([["set-option", "-ga", "update-environment", " AGENT_BROWSER_CONFIG DESK_PANE"]]);
  });

  it("Tmux refuses to append a name that is not an environment variable name", async () => {
    const tmux = await fakeExecutable("tmux", [{ match: ["set-option"], stdout: "" }]);

    expect(await new NodeTmux(tmux.path, { HOME: "/Users/alex" }).appendUpdateEnvironment(["DESK_PANE; run-shell x"])).toBe(false);
    expect(await tmux.calls()).toEqual([]);
  });

  it("under Vitest Desk never finds the operator's own tmux, only one a test names", async () => {
    const tmux = await fakeExecutable("tmux", []);

    expect(await findTmux(null, { VITEST: "true" })).toBeNull();
    expect(await findTmux(tmux.path, { VITEST: "true" })).toBe(tmux.path);
  });
});

describe("tmux sessions for cold restore (docs/IMPLEMENTATION.md §7.4)", () => {
  it("NodeTmux lists each client's terminal and session, names with blanks included", async () => {
    const tmux = await fakeExecutable("tmux", [{ match: ["list-clients"], stdout: "/dev/ttys004 work\n/dev/ttys007 my project\n" }]);

    const clients = await new NodeTmux(tmux.path, { HOME: "/Users/alex" }).clients();

    expect(clients).toEqual([
      { tty: "/dev/ttys004", session: "work" },
      { tty: "/dev/ttys007", session: "my project" },
    ]);
    expect((await tmux.calls())[0]?.argv).toEqual(["list-clients", "-F", "#{client_tty} #{session_name}"]);
  });

  it("NodeTmux gives no clients when no server runs", async () => {
    const tmux = await fakeExecutable("tmux", [{ match: ["list-clients"], stderr: "no server running", exit: 1 }]);

    expect(await new NodeTmux(tmux.path, {}).clients()).toBeNull();
  });

  it("NodeTmux asks has-session for exactly the name, never a prefix", async () => {
    const tmux = await fakeExecutable("tmux", [{ match: ["has-session"], stdout: "" }]);

    expect(await new NodeTmux(tmux.path, {}).hasSession("work")).toBe(true);
    expect((await tmux.calls())[0]?.argv).toEqual(["has-session", "-t", "=work"]);
  });
});
