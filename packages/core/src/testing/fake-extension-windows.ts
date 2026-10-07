import type { ExtensionWindow, ExtensionWindows } from "../ports/extension-windows.ts";

/** Normal windows the test sets; focus requests are recorded. */
export class FakeExtensionWindows implements ExtensionWindows {
  list: ExtensionWindow[];
  readonly focused: number[] = [];

  constructor(list: ExtensionWindow[] = []) {
    this.list = list;
  }

  async normalWindows(): Promise<readonly ExtensionWindow[]> {
    return this.list.map((entry) => ({ ...entry }));
  }

  async focus(id: number): Promise<boolean> {
    this.focused.push(id);
    return this.list.some((entry) => entry.id === id);
  }
}
