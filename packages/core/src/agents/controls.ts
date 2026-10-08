import type { DaemonClient, DaemonNotice } from "../ports/daemon-client.ts";
import type { Prompter } from "../ports/prompter.ts";
import type { TextFiles } from "../ports/text-files.ts";
import { AGENT_POLICY_FILE, agentPolicy, type AgentPolicy } from "./agent-browser.ts";

export type AgentControlPorts = { files: TextFiles; daemon: DaemonClient; prompter: Prompter };

/** §6.5: 64 needs an interactive terminal · 77 the operator declined. */
export type AgentControlResult = { code: 0 | 64 | 77; message: string };

/** The mode `desk agents resume` restores, kept beside the policy while agents are paused. */
const RESUME_FILE = "agent-policy.resume";
const PRIVATE = 0o600;

/** The mode a policy file holds, when it is exactly one Desk writes; `null` for anything else. */
export function policyModeOf(text: string): AgentPolicy | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const modes: AgentPolicy[] = ["open", "strict", "paused"];
  return modes.find((mode) => JSON.stringify(agentPolicy(mode)) === JSON.stringify(parsed)) ?? null;
}

function policyText(mode: AgentPolicy): string {
  return `${JSON.stringify(agentPolicy(mode), null, 2)}\n`;
}

const DESCRIBED: Readonly<Record<"open" | "strict", string>> = { open: "the open policy", strict: "the strict policy" };

async function currentMode(ports: AgentControlPorts, deskHome: string): Promise<AgentPolicy | null> {
  const text = await ports.files.read(`${deskHome}/${AGENT_POLICY_FILE}`);
  return text === null ? null : policyModeOf(text);
}

async function resumeMode(ports: AgentControlPorts, deskHome: string): Promise<"open" | "strict"> {
  const text = (await ports.files.read(`${deskHome}/${RESUME_FILE}`))?.trim();
  return text === "strict" ? "strict" : "open";
}

/** Tells the daemon, so every panel shows or clears the paused notice; a daemon that is not running needs no word. */
async function tellDaemon(ports: AgentControlPorts, paused: boolean): Promise<void> {
  const opened = await ports.daemon.open("cli");
  if (!opened.ok) return;
  try {
    const notice: DaemonNotice = { type: "agents.state", paused };
    await opened.session.notify(notice);
  } finally {
    opened.session.close();
  }
}

/**
 * `desk agents pause` (§11): the policy becomes deny-all but `close`, which agent-browser re-reads before every command;
 * the mode it replaced is kept for `desk agents resume`. Pausing needs no consent: it only takes power away.
 */
export async function pauseAgents(ports: AgentControlPorts, input: { deskHome: string }): Promise<AgentControlResult> {
  const mode = await currentMode(ports, input.deskHome);
  if (mode === "paused") return { code: 0, message: "Agents are already paused; desk agents resume lets them drive this Desk again" };
  await ports.files.write(`${input.deskHome}/${RESUME_FILE}`, `${mode === "strict" ? "strict" : "open"}\n`, PRIVATE);
  await ports.files.write(`${input.deskHome}/${AGENT_POLICY_FILE}`, policyText("paused"), PRIVATE);
  await tellDaemon(ports, true);
  return { code: 0, message: "Agents are paused: every agent-browser command but close is refused. desk agents resume lets them drive this Desk again" };
}

/** `desk agents resume` (§11): after you confirm on a TTY, the mode pausing replaced comes back (open when none was kept). */
export async function resumeAgents(ports: AgentControlPorts, input: { deskHome: string }): Promise<AgentControlResult> {
  const mode = await currentMode(ports, input.deskHome);
  if (mode !== "paused") return { code: 0, message: "Agents are not paused" };
  const resume = await resumeMode(ports, input.deskHome);
  const consent = await ports.prompter.confirm(`Let agents in Desk panes drive this browser again (${DESCRIBED[resume]})?`);
  if (!consent.ok) return { code: 64, message: "desk agents resume needs an interactive terminal to ask you; agents stay paused" };
  if (!consent.yes) return { code: 77, message: "Agents stay paused: you declined" };
  await ports.files.write(`${input.deskHome}/${AGENT_POLICY_FILE}`, policyText(resume), PRIVATE);
  await ports.files.remove(`${input.deskHome}/${RESUME_FILE}`);
  await tellDaemon(ports, false);
  return { code: 0, message: `Agents may drive this Desk again (${DESCRIBED[resume]})` };
}

/**
 * `desk config agent-policy strict|open` (§11): strict needs no consent; open, which lets agents read and change your
 * cookies, storage and saved state, asks on a TTY. While agents are paused it changes the mode `resume` restores.
 */
export async function setAgentPolicy(ports: AgentControlPorts, input: { deskHome: string; mode: "open" | "strict" }): Promise<AgentControlResult> {
  const mode = await currentMode(ports, input.deskHome);
  const paused = mode === "paused";
  const from = paused ? await resumeMode(ports, input.deskHome) : mode;
  if (from === input.mode) return { code: 0, message: `The agent policy is already ${input.mode}` };
  if (input.mode === "open") {
    const consent = await ports.prompter.confirm(
      "Let agents in Desk panes read and change this browser's cookies, storage and saved state (the open policy)?",
    );
    if (!consent.ok) return { code: 64, message: "desk config agent-policy open needs an interactive terminal to ask you; the policy stays strict" };
    if (!consent.yes) return { code: 77, message: "The agent policy stays strict: you declined" };
  }
  if (paused) {
    await ports.files.write(`${input.deskHome}/${RESUME_FILE}`, `${input.mode}\n`, PRIVATE);
    return { code: 0, message: `Agents are paused; desk agents resume restores ${DESCRIBED[input.mode]}` };
  }
  await ports.files.write(`${input.deskHome}/${AGENT_POLICY_FILE}`, policyText(input.mode), PRIVATE);
  return { code: 0, message: `The agent policy is ${input.mode}; agent-browser reads it before its next command` };
}
