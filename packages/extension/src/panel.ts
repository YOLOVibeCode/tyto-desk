import { PanelController } from "@desk/core";
import { BrowserClock, ChromeHostConnector, DocumentVisibility, FOCUS_QUESTION, WebCryptoRandom } from "./chrome-adapters.ts";
import { deskBuild } from "./desk-build.ts";
import { XtermView } from "./xterm-view.ts";

/** The settings until the daemon's hello brings config.json's (§10). */
const TERMINAL = { fontFamily: "Menlo, 'SF Mono', 'DejaVu Sans Mono', monospace", fontSize: 13, scrollback: 5_000, macOptionIsMeta: false };

/**
 * Whether this panel may take the keyboard as it loads: not when it was opened with `focus=0`, nor when the worker says an
 * automatic open is waiting for it (§9, D108). A worker that does not answer within 500 ms leaves the panel focusable.
 */
async function focusOnLoad(): Promise<boolean> {
  if (new URLSearchParams(location.search).get("focus") === "0") return false;
  const answer = await Promise.race([
    chrome.runtime.sendMessage({ type: FOCUS_QUESTION }).catch((err: unknown) => `refused: ${String(err)}`),
    new Promise<string>((resolve) => setTimeout(() => resolve("no answer in 500 ms"), 500)),
  ]);
  // The live suite reads what the panel decided, and why (a test build only).
  if (DESK_TEST) (globalThis as { deskFocusAnswer?: unknown }).deskFocusAnswer = answer;
  return !(typeof answer === "object" && answer !== null && (answer as { focus?: unknown }).focus === false);
}

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
  const findInput = element("find-input");
  if (!(findInput instanceof HTMLInputElement)) throw new Error("panel.html's #find-input is not an input");
  const view = new XtermView(
    { stage: element("terminal"), tabs: element("tabs"), banner, alert: element("alert"), note: element("note"), find: element("find"), findInput },
    TERMINAL,
  );
  const panel = new PanelController({
    connector: new ChromeHostConnector(),
    view,
    layout: view,
    random: new WebCryptoRandom(),
    clock: new BrowserClock(),
    build: deskBuild(),
    windowId: current.id,
    focusOnLoad: await focusOnLoad(),
    visibility: new DocumentVisibility(),
  });
  panel.start();
  // The live suite drives the panel's actions in a test build (the keymap, slice 6b, drives them for you).
  if (DESK_TEST) {
    const hooks = (globalThis as { deskTest?: Record<string, unknown> }).deskTest;
    if (hooks !== undefined) {
      hooks.action = (name: string, argument?: string | number): void => {
        if (name === "split-right") panel.split("right");
        else if (name === "split-down") panel.split("down");
        else if (name === "new-tab") panel.newTab();
        else if (name === "close") panel.closeFocused();
        else if (name === "tab" && typeof argument === "number") panel.selectTab(argument);
        else if (name === "next") panel.focusNext();
        else if (name === "zoom") panel.zoom();
      };
    }
  }
}

void start();
