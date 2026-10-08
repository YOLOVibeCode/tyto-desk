import { describe, expect, it } from "vitest";
import { DESK_SKILL, skillAllowedTools } from "../src/index.ts";

/** What a pre-approved Bash entry runs: its command words before `:*`. */
const command = (entry: string) => /^Bash\((.*?)(?::\*)?\)$/.exec(entry)?.[1] ?? entry;

describe("the desk skill (docs/IMPLEMENTATION.md §11)", () => {
  const allowed = skillAllowedTools(DESK_SKILL).map(command);

  it("the desk skill pre-approves no plugin, cookies, state, storage, eval, network, dashboard, install or connect command and no state-changing desk command", () => {
    const refused = ["plugin", "cookies", "state", "storage", "eval", "network", "dashboard", "install", "connect"];
    const agentBrowser = allowed.filter((entry) => entry.startsWith("agent-browser ")).map((entry) => entry.split(" ")[1]);
    const desk = allowed.filter((entry) => entry.startsWith("desk "));

    expect(agentBrowser.filter((sub) => refused.includes(sub ?? ""))).toEqual([]);
    expect(desk).toEqual(["desk tab current", "desk tab mine", "desk cdp", "desk status"]);
  });

  it("the desk skill pre-approves a screenshot only without a path", () => {
    expect(skillAllowedTools(DESK_SKILL)).toContain("Bash(agent-browser screenshot)");
    expect(allowed.filter((entry) => entry.startsWith("agent-browser screenshot"))).toEqual(["agent-browser screenshot"]);
  });

  it("the desk skill pre-approves only agent-browser, desk and tyto commands", () => {
    expect(allowed.every((entry) => /^(agent-browser|desk|tyto) /.test(entry))).toBe(true);
    expect(allowed).toHaveLength(20);
  });
});
