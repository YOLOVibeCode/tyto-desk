import type { TabOpener } from "../ports/tab-opener.ts";

/** The links the panel opened. */
export class FakeTabOpener implements TabOpener {
  readonly opened: string[] = [];

  open(url: string): void {
    this.opened.push(url);
  }
}
