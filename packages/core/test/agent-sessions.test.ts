import { describe, expect, it } from "vitest";
import { detachAgents, detachEnvironment, listAgents } from "../src/index.ts";
import { FakeAgentSessions } from "../src/testing/index.ts";

const sessions = () =>
  new FakeAgentSessions([
    { session: "desk-p_0000000001", pid: 501 },
    { session: "desk-p_0000000002-2", pid: 502 },
    { session: "main", pid: 503 },
  ]);

describe("desk agents (docs/IMPLEMENTATION.md §11)", () => {
  it("desk agents lists the running desk- sessions and never another", async () => {
    expect(await listAgents(sessions(), { prefix: "desk" })).toEqual({
      code: 0,
      message: "desk-p_0000000001 (pid 501)\ndesk-p_0000000002-2 (pid 502)",
    });
  });

  it("desk agents says so when no Desk agent runs", async () => {
    expect(await listAgents(new FakeAgentSessions(), { prefix: "desk" })).toEqual({ code: 0, message: "No Desk agent sessions are running" });
  });

  it("desk agents detach closes every desk- session and leaves the others", async () => {
    const running = sessions();

    const result = await detachAgents(running, { prefix: "desk" });

    expect(running.closed).toEqual(["desk-p_0000000001", "desk-p_0000000002-2"]);
    expect(running.sessions.map((entry) => entry.session)).toEqual(["main"]);
    expect(result).toEqual({ code: 0, message: "Closed 2 Desk agent sessions; their tabs stay open in the Desk Chrome" });
  });

  it("desk agents detach names a session that did not close and exits 70", async () => {
    const running = sessions();
    running.refuse.add("desk-p_0000000002-2");

    expect(await detachAgents(running, { prefix: "desk" })).toEqual({ code: 70, message: "Closed 1 Desk agent session; desk-p_0000000002-2 did not close" });
  });

  it("desk agents detach runs agent-browser close with Desk's config and none of the caller's restore, namespace, cdp or session-name variables", () => {
    const caller = {
      HOME: "/Users/alex",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      USER: "alex",
      TMPDIR: "/var/folders/xy/T/",
      LANG: "en_US.UTF-8",
      AGENT_BROWSER_CONFIG: "/Users/alex/.agent-browser/config.json",
      AGENT_BROWSER_RESTORE: "main",
      AGENT_BROWSER_SESSION_NAME: "main",
      AGENT_BROWSER_NAMESPACE: "work",
      AGENT_BROWSER_CDP: "9222",
      AGENT_BROWSER_SESSION: "default",
      AGENT_BROWSER_SOCKET_DIR: "/tmp/ab",
      NODE_OPTIONS: "--require /tmp/x.js",
    };

    expect(detachEnvironment(caller, "/Users/alex/.desk/agent-browser.json")).toEqual({
      HOME: "/Users/alex",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      USER: "alex",
      TMPDIR: "/var/folders/xy/T/",
      LANG: "en_US.UTF-8",
      AGENT_BROWSER_CONFIG: "/Users/alex/.desk/agent-browser.json",
    });
  });
});
