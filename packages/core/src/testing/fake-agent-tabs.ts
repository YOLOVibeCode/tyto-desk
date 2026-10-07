import type { AgentTabs } from "../ports/agent-tabs.ts";

/** Tab groups by title (`groups`: title → tab id); a create records its call and gives tab ids from 100. */
export class FakeAgentTabs implements AgentTabs {
  readonly groups = new Map<string, number>();
  readonly created: { group: string; windowId: number }[] = [];
  /** Runs after each create with the new tab's id, as Chrome would list it. */
  onCreate: (tabId: number) => void = () => undefined;

  async find(group: string): Promise<number | null> {
    return this.groups.get(group) ?? null;
  }

  async create(group: string, windowId: number): Promise<number | null> {
    this.created.push({ group, windowId });
    const tabId = 99 + this.created.length;
    this.groups.set(group, tabId);
    this.onCreate(tabId);
    return tabId;
  }
}
