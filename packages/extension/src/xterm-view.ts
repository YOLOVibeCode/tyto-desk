import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { TerminalPane, TerminalSize, TerminalView } from "@desk/core";

export type XtermOptions = { fontFamily: string; fontSize: number; scrollback: number };

/** What the live suite reads in a test build (docs/IMPLEMENTATION.md §17.3); production builds drop it. */
type TestHooks = { screen(paneId: string): string; panes(): string[] };

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
    fit.fit();
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(element);
    this.terminals.set(paneId, term);
    return {
      write: (data) => term.write(data),
      reset: () => term.reset(),
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

  banner(text: string | null): void {
    this.bannerElement.textContent = text ?? "";
    this.bannerElement.hidden = text === null;
  }
}
