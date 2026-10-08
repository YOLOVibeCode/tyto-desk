import { describe, expect, it } from "vitest";
import { agentPolicy, pauseAgents, policyModeOf, resumeAgents, setAgentPolicy } from "../src/index.ts";
import { FakeDaemonClient, MemoryTextFiles, ScriptedPrompter } from "../src/testing/index.ts";

const deskHome = "/Users/alex/.desk";
const POLICY = `${deskHome}/agent-policy.json`;
const RESUME = `${deskHome}/agent-policy.resume`;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function setup(mode: "open" | "strict" | "paused" | null, answers: (boolean | "no-tty")[] = []) {
  const files = new MemoryTextFiles(mode === null ? {} : { [POLICY]: json(agentPolicy(mode)) });
  const daemon = new FakeDaemonClient();
  const prompter = new ScriptedPrompter(answers);
  const ports = { files, daemon, prompter };
  return { files, daemon, prompter, ports };
}

const written = async (files: MemoryTextFiles) => policyModeOf((await files.read(POLICY)) ?? "");

describe("agent controls (docs/IMPLEMENTATION.md §11)", () => {
  it.each([["open"], ["strict"], ["paused"]] as const)("the %s policy reads back as its mode", (mode) => {
    expect(policyModeOf(json(agentPolicy(mode)))).toBe(mode);
  });

  it("a policy Desk did not write reads as no mode", () => {
    expect(policyModeOf(json({ default: "allow", deny: ["click"] }))).toBeNull();
    expect(policyModeOf("{")).toBeNull();
  });

  it("desk agents pause writes a deny-all policy that still allows close", async () => {
    const desk = setup("strict");

    const result = await pauseAgents(desk.ports, { deskHome });

    expect(JSON.parse((await desk.files.read(POLICY)) ?? "{}")).toEqual({ default: "deny", allow: ["close"] });
    expect(await desk.files.read(RESUME)).toBe("strict\n");
    expect(desk.daemon.notices).toContainEqual({ type: "agents.state", paused: true });
    expect(result).toEqual({ code: 0, message: "Agents are paused: every agent-browser command but close is refused. desk agents resume lets them drive this Desk again" });
  });

  it("desk agents pause on paused agents changes nothing", async () => {
    const desk = setup("paused");
    await desk.files.write(RESUME, "open\n", 0o600);

    const result = await pauseAgents(desk.ports, { deskHome });

    expect(await desk.files.read(RESUME)).toBe("open\n");
    expect(result).toMatchObject({ code: 0, message: expect.stringContaining("already paused") });
  });

  it("desk agents resume asks on a TTY and restores the previous mode", async () => {
    const desk = setup("strict", [true]);
    await pauseAgents(desk.ports, { deskHome });

    const result = await resumeAgents(desk.ports, { deskHome });

    expect(desk.prompter.asked).toEqual(["Let agents in Desk panes drive this browser again (the strict policy)?"]);
    expect(await written(desk.files)).toBe("strict");
    expect(await desk.files.read(RESUME)).toBeNull();
    expect(desk.daemon.notices).toContainEqual({ type: "agents.state", paused: false });
    expect(result).toEqual({ code: 0, message: "Agents may drive this Desk again (the strict policy)" });
  });

  it("desk agents resume keeps agents paused when you decline", async () => {
    const desk = setup("paused", [false]);
    await desk.files.write(RESUME, "open\n", 0o600);

    const result = await resumeAgents(desk.ports, { deskHome });

    expect(await written(desk.files)).toBe("paused");
    expect(result).toEqual({ code: 77, message: "Agents stay paused: you declined" });
  });

  it("desk agents resume refuses without a terminal to ask on", async () => {
    const desk = setup("paused", ["no-tty"]);

    expect(await resumeAgents(desk.ports, { deskHome })).toMatchObject({ code: 64 });
    expect(await written(desk.files)).toBe("paused");
  });

  it("desk agents resume restores open when no previous mode was recorded", async () => {
    const desk = setup("paused", [true]);

    await resumeAgents(desk.ports, { deskHome });

    expect(await written(desk.files)).toBe("open");
  });

  it("desk config agent-policy strict needs no question", async () => {
    const desk = setup("open");

    const result = await setAgentPolicy(desk.ports, { deskHome, mode: "strict" });

    expect(desk.prompter.asked).toEqual([]);
    expect(await written(desk.files)).toBe("strict");
    expect(result.code).toBe(0);
  });

  it("desk config agent-policy open asks on a TTY", async () => {
    const desk = setup("strict", [true]);

    await setAgentPolicy(desk.ports, { deskHome, mode: "open" });

    expect(desk.prompter.asked).toEqual([
      "Let agents in Desk panes read and change this browser's cookies, storage and saved state (the open policy)?",
    ]);
    expect(await written(desk.files)).toBe("open");
  });

  it("desk config agent-policy open keeps strict when you decline", async () => {
    const desk = setup("strict", [false]);

    expect(await setAgentPolicy(desk.ports, { deskHome, mode: "open" })).toMatchObject({ code: 77 });
    expect(await written(desk.files)).toBe("strict");
  });

  it("a policy change while agents are paused changes what desk agents resume restores", async () => {
    const desk = setup("strict", [true]);
    await pauseAgents(desk.ports, { deskHome });

    const result = await setAgentPolicy(desk.ports, { deskHome, mode: "open" });

    expect(await written(desk.files)).toBe("paused");
    expect(await desk.files.read(RESUME)).toBe("open\n");
    expect(result.message).toContain("desk agents resume");
  });
});
