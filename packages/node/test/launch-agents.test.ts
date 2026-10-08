import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeLaunchAgents } from "../src/index.ts";
import { fakeExecutable } from "../../../test/fixtures/fake-exec.ts";

describe("NodeLaunchAgents (macOS)", () => {
  it("install writes the plist with the argv and RunAtLoad, and bootstraps it into the user's GUI domain", async () => {
    const home = await mkdtemp(join(tmpdir(), "agents-home-"));
    const launchctl = await fakeExecutable("launchctl", [{ match: ["bootstrap"], stdout: "" }]);
    const agents = new NodeLaunchAgents({ home, uid: 501, launchctl: launchctl.path });

    expect(await agents.install("com.noctusoft.desk.login", ["/Users/alex/.local/bin/desk"])).toBe(true);

    const plist = join(home, "Library", "LaunchAgents", "com.noctusoft.desk.login.plist");
    const text = await readFile(plist, "utf8");
    expect(text).toContain("<string>/Users/alex/.local/bin/desk</string>");
    expect(text).toContain("<key>RunAtLoad</key><true/>");
    expect((await stat(plist)).mode & 0o777).toBe(0o644);
    expect((await launchctl.calls()).map((call) => call.argv)).toEqual([["bootstrap", "gui/501", plist]]);
    expect(await agents.installed("com.noctusoft.desk.login")).toBe(true);
  });

  it("remove boots the agent out and deletes its plist", async () => {
    const home = await mkdtemp(join(tmpdir(), "agents-home-"));
    const launchctl = await fakeExecutable("launchctl", [{ match: [], stdout: "" }]);
    const agents = new NodeLaunchAgents({ home, uid: 501, launchctl: launchctl.path });
    await agents.install("com.noctusoft.desk.login", ["/x/desk"]);

    await agents.remove("com.noctusoft.desk.login");

    expect(await agents.installed("com.noctusoft.desk.login")).toBe(false);
    expect((await launchctl.calls()).map((call) => call.argv).at(-1)).toEqual(["bootout", "gui/501/com.noctusoft.desk.login"]);
  });

  it("a label that is not a reverse-DNS name is refused", async () => {
    const agents = new NodeLaunchAgents({ home: await mkdtemp(join(tmpdir(), "agents-home-")), uid: 501 });

    await expect(agents.installed("../evil")).rejects.toThrow(RangeError);
  });
});
