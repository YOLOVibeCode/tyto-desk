import type { DevToolsHttp } from "../ports/dev-tools-http.ts";

/** `/json/version` answers once `answering` is set (a Chrome that started), else nothing; every probe is recorded. */
export class FakeDevToolsHttp implements DevToolsHttp {
  answering: boolean;
  /** Probes to stay silent for after `answering` is set, as a starting Chrome is. */
  silentProbes = 0;
  readonly probed: number[] = [];
  private readonly browser: string;
  private readonly log: string[];

  constructor(options: { answering?: boolean; browser?: string; log?: string[] } = {}) {
    this.answering = options.answering ?? false;
    this.browser = options.browser ?? "Chrome/155.0.8059.40";
    this.log = options.log ?? [];
  }

  async version(port: number): Promise<{ browser: string; wsUrl: string } | null> {
    this.probed.push(port);
    if (!this.answering) return null;
    if (this.silentProbes > 0) {
      this.silentProbes -= 1;
      return null;
    }
    this.log.push("json/version answered");
    return { browser: this.browser, wsUrl: `ws://127.0.0.1:${port}/devtools/browser/0b5ad5d6-0000-4000-8000-000000000001` };
  }
}
