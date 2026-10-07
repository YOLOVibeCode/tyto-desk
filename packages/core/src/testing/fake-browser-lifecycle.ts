import type { BrowserLifecycle } from "../ports/browser-lifecycle.ts";

/** Counts Browser.close; `onClose` is where the test's Chrome stops answering. */
export class FakeBrowserLifecycle implements BrowserLifecycle {
  closes = 0;
  onClose: () => void = () => undefined;
  private readonly log: string[];

  constructor(log: string[] = []) {
    this.log = log;
  }

  async close(): Promise<boolean> {
    this.closes += 1;
    this.log.push("lifecycle.close");
    this.onClose();
    return true;
  }
}
