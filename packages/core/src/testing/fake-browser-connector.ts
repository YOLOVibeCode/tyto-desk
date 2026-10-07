import type { BrowserConnector, BrowserSession } from "../ports/browser-connector.ts";
import type { BrowserLifecycle } from "../ports/browser-lifecycle.ts";
import type { ChromeSettings } from "../ports/chrome-settings.ts";
import type { DeskExtension } from "../ports/desk-extension.ts";
import type { PanelOpener } from "../ports/panel-opener.ts";
import { FakeBrowserLifecycle } from "./fake-browser-lifecycle.ts";
import { FakeChromeSettings } from "./fake-chrome-settings.ts";

/** Connects to any URL (recorded) with the given role fakes, or fails while `failing` is set; settings and the lifecycle default to fresh fakes. */
export class FakeBrowserConnector implements BrowserConnector {
  readonly connected: string[] = [];
  closed = 0;
  failing = false;
  private readonly extension: DeskExtension;
  private readonly panels: PanelOpener;
  private readonly settings: ChromeSettings;
  private readonly lifecycle: BrowserLifecycle;
  private readonly log: string[];

  constructor(
    extension: DeskExtension,
    panels: PanelOpener,
    log: string[] = [],
    roles: { settings?: ChromeSettings; lifecycle?: BrowserLifecycle } = {},
  ) {
    this.extension = extension;
    this.panels = panels;
    this.settings = roles.settings ?? new FakeChromeSettings();
    this.lifecycle = roles.lifecycle ?? new FakeBrowserLifecycle(log);
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
        settings: this.settings,
        lifecycle: this.lifecycle,
        close: () => {
          this.closed += 1;
        },
      },
    };
  }
}
