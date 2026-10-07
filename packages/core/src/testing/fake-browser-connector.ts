import type { BrowserConnector, BrowserSession } from "../ports/browser-connector.ts";
import type { DeskExtension } from "../ports/desk-extension.ts";
import type { PanelOpener } from "../ports/panel-opener.ts";

/** Connects to any URL (recorded) with the given role fakes, or fails while `failing` is set. */
export class FakeBrowserConnector implements BrowserConnector {
  readonly connected: string[] = [];
  closed = 0;
  failing = false;
  private readonly extension: DeskExtension;
  private readonly panels: PanelOpener;
  private readonly log: string[];

  constructor(extension: DeskExtension, panels: PanelOpener, log: string[] = []) {
    this.extension = extension;
    this.panels = panels;
    this.log = log;
  }

  async connect(wsUrl: string): Promise<{ ok: true; session: BrowserSession } | { ok: false }> {
    if (this.failing) return { ok: false };
    this.connected.push(wsUrl);
    this.log.push("browser.connect");
    return {
      ok: true,
      session: {
        extension: this.extension,
        panels: this.panels,
        close: () => {
          this.closed += 1;
        },
      },
    };
  }
}
