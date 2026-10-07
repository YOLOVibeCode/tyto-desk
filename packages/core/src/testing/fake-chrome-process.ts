import type { ChromeProcess, ChromeStart } from "../ports/chrome-process.ts";

/** An installed Chrome of `installed` (null: none); every start is recorded and runs `onStart`, as Chrome would act. */
export class FakeChromeProcess implements ChromeProcess {
  installed: string | null;
  readonly starts: (readonly string[])[] = [];
  refuseGui = false;
  onStart: () => void = () => undefined;
  private readonly log: string[];

  constructor(installed: string | null, log: string[] = []) {
    this.installed = installed;
    this.log = log;
  }

  async version(): Promise<string | null> {
    return this.installed;
  }

  async start(args: readonly string[]): Promise<ChromeStart> {
    if (this.refuseGui) return { ok: false, reason: "gui-refused" };
    this.starts.push(args);
    this.log.push("chrome.start");
    this.onStart();
    return { ok: true, pid: 5100 };
  }
}
