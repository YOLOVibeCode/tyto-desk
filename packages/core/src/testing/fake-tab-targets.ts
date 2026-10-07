import type { TabTargets } from "../ports/tab-targets.ts";

/** Each window's active tab id (`active`) and each tab's target id (`targets`). */
export class FakeTabTargets implements TabTargets {
  readonly active: Map<number, number>;
  readonly targets: Map<number, string>;

  constructor(input: { active?: Map<number, number>; targets?: Map<number, string> } = {}) {
    this.active = input.active ?? new Map();
    this.targets = input.targets ?? new Map();
  }

  async activeTabTarget(windowId: number): Promise<string | null> {
    const tab = this.active.get(windowId);
    return tab === undefined ? null : (this.targets.get(tab) ?? null);
  }

  async targetOfTab(tabId: number): Promise<string | null> {
    return this.targets.get(tabId) ?? null;
  }
}
