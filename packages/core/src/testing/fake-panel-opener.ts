import type { PanelOpener } from "../ports/panel-opener.ts";

/** Tab targets by window id; toolbar actions and new windows are recorded and run their callbacks. */
export class FakePanelOpener implements PanelOpener {
  readonly tabs = new Map<number, string>();
  readonly opened: { extensionId: string; tab: string }[] = [];
  newWindows = 0;
  onOpen: (tab: string) => void = () => undefined;
  onNewWindow: () => void = () => undefined;
  private readonly log: string[];

  constructor(log: string[] = []) {
    this.log = log;
  }

  async tabTargetInWindow(windowId: number): Promise<string | null> {
    return this.tabs.get(windowId) ?? null;
  }

  async anyTabTarget(): Promise<string | null> {
    return [...this.tabs.values()][0] ?? null;
  }

  async open(extensionId: string, tabTargetId: string): Promise<boolean> {
    this.opened.push({ extensionId, tab: tabTargetId });
    this.log.push(`panels.open ${tabTargetId}`);
    this.onOpen(tabTargetId);
    return true;
  }

  async newWindow(): Promise<boolean> {
    this.newWindows += 1;
    this.log.push("panels.newWindow");
    this.onNewWindow();
    return true;
  }
}
