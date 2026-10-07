import { describe, expect, it } from "vitest";
import { NodeTmux } from "../src/index.ts";
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
});
