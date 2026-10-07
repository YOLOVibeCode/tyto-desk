import type { DeskWindow, ExtensionBridge } from "../ports/extension-bridge.ts";

/**
 * The worker's view of the Desk windows (`null`: it does not answer), the active tab's target (`current`), and each
 * pane's agent tab (`mine`); focus requests are recorded.
 */
export class FakeExtensionBridge implements ExtensionBridge {
  windowList: DeskWindow[] | null;
  readonly focused: number[] = [];
  current: string | null = null;
  readonly mine = new Map<string, string>();
  readonly autoOpens: { windowId: number; close: boolean }[] = [];
  autoOpenAnswers = true;

  constructor(windowList: DeskWindow[] | null = []) {
    this.windowList = windowList;
  }

  async windows(): Promise<readonly DeskWindow[] | null> {
    return this.windowList === null ? null : this.windowList.map((entry) => ({ ...entry }));
  }

  async focusWindow(id: number): Promise<boolean> {
    this.focused.push(id);
    return true;
  }

  async tabCurrent(): Promise<string | null> {
    return this.current;
  }

  async autoOpen(windowId: number, close: boolean): Promise<boolean> {
    if (!this.autoOpenAnswers) return false;
    this.autoOpens.push({ windowId, close });
    return true;
  }

  async tabMine(pane: string): Promise<string | null> {
    return this.mine.get(pane) ?? null;
  }
}
