import type { PageFocus } from "../ports/page-focus.ts";

/** Records each page given the keyboard back. */
export class FakePageFocus implements PageFocus {
  readonly fronted: string[] = [];
  private readonly log: string[];

  constructor(log: string[] = []) {
    this.log = log;
  }

  async bringToFront(targetId: string): Promise<boolean> {
    this.fronted.push(targetId);
    this.log.push(`pages.bringToFront ${targetId}`);
    return true;
  }
}
