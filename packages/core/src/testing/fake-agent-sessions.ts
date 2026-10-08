import type { AgentSession, AgentSessions } from "../ports/agent-sessions.ts";

/** Sessions the test lists; closing one removes it, and a name in `refuse` stays. */
export class FakeAgentSessions implements AgentSessions {
  sessions: AgentSession[];
  readonly closed: string[] = [];
  readonly refuse = new Set<string>();

  constructor(sessions: AgentSession[] = []) {
    this.sessions = sessions;
  }

  async list(prefix: string): Promise<readonly AgentSession[]> {
    return this.sessions.filter((entry) => entry.session.startsWith(prefix));
  }

  async close(session: string): Promise<boolean> {
    if (this.refuse.has(session)) return false;
    this.closed.push(session);
    this.sessions = this.sessions.filter((entry) => entry.session !== session);
    return true;
  }
}
