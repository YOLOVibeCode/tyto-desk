import type { TmuxClient, TmuxSessions } from "../ports/tmux-sessions.ts";

/** Sessions and clients as the test sets them; every has-session asked is recorded. */
export class FakeTmuxSessions implements TmuxSessions {
  readonly sessions = new Set<string>();
  clientList: TmuxClient[] | null = [];
  readonly asked: string[] = [];

  async clients(): Promise<readonly TmuxClient[] | null> {
    return this.clientList === null ? null : [...this.clientList];
  }

  async hasSession(name: string): Promise<boolean> {
    this.asked.push(name);
    return this.sessions.has(name);
  }
}
