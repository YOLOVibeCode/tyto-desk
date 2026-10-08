import type { AgentSessions } from "../ports/agent-sessions.ts";

/** The variables `detach` passes on; everything else (a restore key, a namespace, a cdp, a session name) stays behind. */
const DETACH_KEPT = ["HOME", "PATH", "USER", "TMPDIR", "LANG"];

/**
 * The environment `agent-browser --session <s> close` runs with (§11): only `HOME`, `PATH`, `USER`, `TMPDIR` and `LANG` of
 * the caller's, and Desk's config, because under your own config `close` would save the Desk cookie jar into your
 * `main` state.
 */
export function detachEnvironment(caller: Readonly<Record<string, string | undefined>>, deskAgentConfig: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of DETACH_KEPT) {
    const value = caller[name];
    if (value !== undefined) env[name] = value;
  }
  env.AGENT_BROWSER_CONFIG = deskAgentConfig;
  return env;
}

/** `desk agents`: the running agent-browser sessions Desk panes started (`<prefix>-…`). */
export async function listAgents(sessions: AgentSessions, input: { prefix: string }): Promise<{ code: 0; message: string }> {
  const running = await sessions.list(`${input.prefix}-`);
  if (running.length === 0) return { code: 0, message: "No Desk agent sessions are running" };
  return { code: 0, message: running.map((entry) => `${entry.session} (pid ${entry.pid})`).join("\n") };
}

/** `desk agents detach`: closes every Desk agent session; their tabs stay in the Desk Chrome. 70 when one did not close. */
export async function detachAgents(sessions: AgentSessions, input: { prefix: string }): Promise<{ code: 0 | 70; message: string }> {
  const running = await sessions.list(`${input.prefix}-`);
  const failed: string[] = [];
  let closed = 0;
  for (const entry of running) {
    if (await sessions.close(entry.session)) closed += 1;
    else failed.push(entry.session);
  }
  const count = `Closed ${closed} Desk agent session${closed === 1 ? "" : "s"}`;
  if (failed.length > 0) return { code: 70, message: `${count}; ${failed.join(", ")} did not close` };
  return { code: 0, message: `${count}; their tabs stay open in the Desk Chrome` };
}
