import type { DeskWindow, ExtensionBridge } from "../ports/extension-bridge.ts";

/** The worker's view of the Desk windows (`null`: it does not answer); focus requests are recorded. */
export class FakeExtensionBridge implements ExtensionBridge {
  windowList: DeskWindow[] | null;
  readonly focused: number[] = [];

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
}
