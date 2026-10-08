import { join } from "node:path";
import { detachAgents, listAgents, pauseAgents, resumeAgents, setAgentPolicy, type Prompter } from "@desk/core";
import { FileConfigStore, NodeTextFiles } from "@desk/node";
import { NodeAgentSessions } from "./agent-sessions.ts";
import { UnixDaemonClient } from "./daemon-client.ts";
import type { CommandResult } from "./install.ts";

export type AgentsInput = {
  env: NodeJS.ProcessEnv;
  home: string;
  deskHome: string;
  version: string;
  prompter: Prompter;
};

function controlPorts(input: AgentsInput) {
  return {
    files: new NodeTextFiles(),
    daemon: new UnixDaemonClient(join(input.deskHome, "run", "ptyd.sock"), input.version),
    prompter: input.prompter,
  };
}

/** `desk agents [pause|resume|detach]` (docs/IMPLEMENTATION.md §11). */
export async function agentsCommand(input: AgentsInput & { action: "list" | "pause" | "resume" | "detach" }): Promise<CommandResult> {
  const config = await new FileConfigStore(input.deskHome).load();
  if (config === null) return { code: 69, message: "Desk has no config yet; run desk" };
  const sessions = new NodeAgentSessions({ home: input.home, deskHome: input.deskHome, caller: input.env });
  const prefix = config.agents.sessionPrefix;
  switch (input.action) {
    case "list":
      return listAgents(sessions, { prefix });
    case "detach":
      return detachAgents(sessions, { prefix });
    case "pause":
      return pauseAgents(controlPorts(input), { deskHome: input.deskHome });
    case "resume":
      return resumeAgents(controlPorts(input), { deskHome: input.deskHome });
    default: {
      const never: never = input.action;
      throw new Error(`unknown agents action ${String(never)}`);
    }
  }
}

/** `desk config agent-policy strict|open` (§11). */
export async function agentPolicyCommand(input: AgentsInput & { mode: "strict" | "open" }): Promise<CommandResult> {
  return setAgentPolicy(controlPorts(input), { deskHome: input.deskHome, mode: input.mode });
}
