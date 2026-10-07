import { PanelController } from "@desk/core";
import { BrowserClock, ChromeHostConnector, DocumentVisibility, WebCryptoRandom } from "./chrome-adapters.ts";
import { deskBuild } from "./desk-build.ts";
import { XtermView } from "./xterm-view.ts";

const TERMINAL = { fontFamily: "Menlo, 'SF Mono', 'DejaVu Sans Mono', monospace", fontSize: 13, scrollback: 5_000 };

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`panel.html has no #${id}`);
  return found;
}

/**
 * The side panel (docs/IMPLEMENTATION.md §9). It refuses to run in a tab, where a page could be framed to look like the
 * panel: there it says how to open Desk and opens no native connection. In the panel it runs core's PanelController
 * over xterm, and focuses the terminal on load unless it was opened with `focus=0`.
 */
async function start(): Promise<void> {
  const banner = element("banner");
  if ((await chrome.tabs.getCurrent()) !== undefined) {
    banner.textContent = "Open Desk with its shortcut, or from the Desk toolbar button: the terminal runs only in the side panel.";
    banner.hidden = false;
    return;
  }
  const current = await chrome.windows.getCurrent();
  if (typeof current.id !== "number") return;
  new PanelController({
    connector: new ChromeHostConnector(),
    view: new XtermView(element("terminal"), banner, TERMINAL),
    random: new WebCryptoRandom(),
    clock: new BrowserClock(),
    build: deskBuild(),
    windowId: current.id,
    focusOnLoad: new URLSearchParams(location.search).get("focus") !== "0",
    visibility: new DocumentVisibility(),
  }).start();
}

void start();
