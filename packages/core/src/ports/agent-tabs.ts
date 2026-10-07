/**
 * The agent tabs of Desk panes (docs/IMPLEMENTATION.md §3, §11): each pane's agent works in a tab of its own, in a tab
 * group named after the pane. Adapter: `chrome.tabs` and `chrome.tabGroups`.
 */
export interface AgentTabs {
  /** A tab in the group with this title, or `null` when there is none. */
  find(group: string): Promise<number | null>;
  /** Creates a background tab in a new group with this title in the window; `null` when Chrome refused. */
  create(group: string, windowId: number): Promise<number | null>;
}
