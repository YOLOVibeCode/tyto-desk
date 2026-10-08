import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeAgentSessions } from "../src/agent-sessions.ts";
import { fakeExecutable } from "../../../test/fixtures/fake-exec.ts";

async function home(pids: Record<string, number>) {
  const dir = await mkdtemp(join(tmpdir(), "agents-home-"));
  await mkdir(join(dir, ".agent-browser"));
  for (const [session, pid] of Object.entries(pids)) await writeFile(join(dir, ".agent-browser", `${session}.pid`), `${pid}\n`);
  return dir;
}

describe("Desk's agent-browser sessions (docs/IMPLEMENTATION.md §11)", () => {
  it("the sessions are the live desk- pids in ~/.agent-browser", async () => {
    const dir = await home({ "desk-p_0000000001": process.pid, "desk-p_0000000002": 999_999_9, main: process.pid });
    const sessions = new NodeAgentSessions({ home: dir, deskHome: join(dir, ".desk"), caller: {} });

    expect(await sessions.list("desk-")).toEqual([{ session: "desk-p_0000000001", pid: process.pid }]);
  });

  it("there are no sessions without ~/.agent-browser", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agents-home-"));

    expect(await new NodeAgentSessions({ home: dir, deskHome: join(dir, ".desk"), caller: {} }).list("desk-")).toEqual([]);
  });

  it("close runs agent-browser --session <s> close as argv with Desk's config and a clean environment", async () => {
    const dir = await home({});
    const agentBrowser = await fakeExecutable("agent-browser", [{ match: ["--session"], stdout: "✓ closed\n" }]);
    const sessions = new NodeAgentSessions({
      home: dir,
      deskHome: join(dir, ".desk"),
      caller: { HOME: dir, PATH: "/usr/bin:/bin", AGENT_BROWSER_RESTORE: "main", AGENT_BROWSER_NAMESPACE: "work", AGENT_BROWSER_CONFIG: join(dir, "mine.json") },
      binary: agentBrowser.path,
    });

    expect(await sessions.close("desk-p_0000000001")).toBe(true);
    const [call] = await agentBrowser.calls();
    expect(call?.argv).toEqual(["--session", "desk-p_0000000001", "close"]);
    expect(call?.env.AGENT_BROWSER_CONFIG).toBe(join(dir, ".desk", "agent-browser.json"));
    expect(Object.keys(call?.env ?? {}).filter((name) => name.startsWith("AGENT_BROWSER_"))).toEqual(["AGENT_BROWSER_CONFIG"]);
  });

  it("close refuses a session name agent-browser could read as a flag", async () => {
    const dir = await home({});
    const agentBrowser = await fakeExecutable("agent-browser", [{ match: ["--session"], stdout: "" }]);
    const sessions = new NodeAgentSessions({ home: dir, deskHome: join(dir, ".desk"), caller: {}, binary: agentBrowser.path });

    expect(await sessions.close("--restore")).toBe(false);
    expect(await sessions.close("--restore x")).toBe(false);
    expect(await agentBrowser.calls()).toEqual([]);
  });
});
