import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { BannerAction, TerminalPane, TerminalSize, TerminalView } from "@desk/core";

export type XtermOptions = { fontFamily: string; fontSize: number; scrollback: number };

/** What the live suite reads in a test build (docs/IMPLEMENTATION.md §17.3); production builds drop it. */
type TestHooks = { screen(paneId: string): string; panes(): string[]; banner(): string; calls(paneId: string): string[] };

/**
 * The panel's terminals (§10's xterm options, slice 1c's subset): `convertEol` false, the scrollback the mirror keeps,
 * Option as Option (not Meta), and Option-click forcing a selection; each fills its element and follows its size. The
 * banner shows text only, never markup.
 */
export class XtermView implements TerminalView {
  private readonly container: HTMLElement;
  private readonly bannerElement: HTMLElement;
  private readonly options: XtermOptions;
  private readonly terminals = new Map<string, Terminal>();
  /** In a test build, each pane's last 200 resets, writes (their length) and resizes, for the live suite's reports. */
  private readonly calls = new Map<string, string[]>();

  constructor(container: HTMLElement, bannerElement: HTMLElement, options: XtermOptions) {
    this.container = container;
    this.bannerElement = bannerElement;
    this.options = options;
    if (DESK_TEST) {
      const hooks: TestHooks = {
        screen: (paneId) => {
          const buffer = this.terminals.get(paneId)?.buffer.active;
          if (buffer === undefined) return "";
          const lines: string[] = [];
          for (let row = 0; row < buffer.length; row += 1) lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
          return lines.join("\n").replace(/\n+$/, "");
        },
        panes: () => [...this.terminals.keys()],
        banner: () => (this.bannerElement.hidden ? "" : (this.bannerElement.textContent ?? "")),
        calls: (paneId) => [...(this.calls.get(paneId) ?? [])],
      };
      (globalThis as { deskTest?: TestHooks }).deskTest = hooks;
    }
  }

  create(paneId: string): TerminalPane {
    const element = document.createElement("div");
    this.container.append(element);
    const term = new Terminal({
      convertEol: false,
      scrollback: this.options.scrollback,
      fontFamily: this.options.fontFamily,
      fontSize: this.options.fontSize,
      macOptionIsMeta: false,
      macOptionClickForcesSelection: true,
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    // Fit only a laid-out element: before the side panel lays the page out, fit measures nothing and gives 2×1, and a
    // pane opened at that size reflows its mirror and makes zsh redraw a prompt it believes is six lines tall (D106).
    const laidOut = () => element.clientWidth > 0 && element.clientHeight > 0;
    if (laidOut()) fit.fit();
    const observer = new ResizeObserver(() => {
      if (laidOut()) fit.fit();
    });
    observer.observe(element);
    this.terminals.set(paneId, term);
    const pasteListeners: ((text: string) => void)[] = [];
    // The panel takes paste and drop before xterm (§10): text is sanitized by the panel; dropped files are ignored.
    const intercept = (event: ClipboardEvent | DragEvent, text: string | undefined) => {
      event.preventDefault();
      event.stopPropagation();
      if (text !== undefined && text !== "") for (const listener of pasteListeners) listener(text);
    };
    element.addEventListener("paste", (event) => intercept(event, event.clipboardData?.getData("text/plain")), { capture: true });
    element.addEventListener("drop", (event) => intercept(event, event.dataTransfer?.getData("text/plain")), { capture: true });
    element.addEventListener("dragover", (event) => event.preventDefault(), { capture: true });
    const note = (call: string) => {
      if (!DESK_TEST) return;
      const list = this.calls.get(paneId) ?? [];
      list.push(`${Math.round(performance.now())} ${call}`);
      if (list.length > 200) list.shift();
      this.calls.set(paneId, list);
    };
    term.onResize((size) => note(`resized ${size.cols}x${size.rows}`));
    return {
      write: (data, done) => {
        note(`write ${data.length} ${JSON.stringify(data.slice(0, 120))}`);
        term.write(data, done);
      },
      paste: (text) => term.paste(text),
      bracketedPasteMode: () => term.modes.bracketedPasteMode,
      onPaste: (listener) => {
        pasteListeners.push(listener);
      },
      reset: () => {
        note("reset");
        term.reset();
      },
      size: (): TerminalSize => ({ cols: term.cols, rows: term.rows }),
      onInput: (listener) => {
        term.onData(listener);
      },
      onResize: (listener) => {
        term.onResize((size) => listener({ cols: size.cols, rows: size.rows }));
      },
      focus: () => term.focus(),
      dispose: () => {
        observer.disconnect();
        this.terminals.delete(paneId);
        term.dispose();
        element.remove();
      },
    };
  }

  /** Asks in the banner, with Paste and Cancel buttons; Escape or Cancel is no. */
  confirm(question: string): Promise<boolean> {
    return new Promise((resolve) => {
      const answer = (yes: boolean) => {
        this.bannerElement.hidden = true;
        this.bannerElement.textContent = "";
        resolve(yes);
      };
      this.bannerElement.textContent = question;
      const yes = document.createElement("button");
      yes.type = "button";
      yes.textContent = "Paste";
      yes.addEventListener("click", () => answer(true), { once: true });
      const no = document.createElement("button");
      no.type = "button";
      no.textContent = "Cancel";
      no.addEventListener("click", () => answer(false), { once: true });
      this.bannerElement.append(" ", yes, " ", no);
      this.bannerElement.hidden = false;
      yes.focus();
    });
  }

  banner(text: string | null, action?: BannerAction): void {
    this.bannerElement.textContent = text ?? "";
    if (text !== null && action !== undefined) {
      // A real button, its label set as text: the banner never takes markup.
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.addEventListener("click", () => action.run(), { once: true });
      this.bannerElement.append(" ", button);
    }
    this.bannerElement.hidden = text === null;
  }
}
