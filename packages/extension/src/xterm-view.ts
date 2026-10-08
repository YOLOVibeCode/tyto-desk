import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import type {
  BannerAction,
  KeyInput,
  LayoutNode,
  LayoutShown,
  LayoutView,
  MenuItem,
  SplitPath,
  TerminalPane,
  TerminalSettings,
  TerminalSize,
  TerminalView,
} from "@desk/core";

/** One pane's xterm and what the view keeps for it. */
type Held = { term: Terminal; fit: FitAddon; search: SearchAddon; element: HTMLElement; laidOut(): boolean };

/** What the live suite reads in a test build (docs/IMPLEMENTATION.md §17.3); production builds drop it. */
type TestHooks = {
  screen(paneId: string): string;
  panes(): string[];
  banner(): string;
  alert(): string;
  calls(paneId: string): string[];
  /** What the panel shows: its tabs and the active tab's splits. */
  layout(): LayoutShown | null;
  /** The pane the keyboard is in, if any. */
  focused(): string | null;
  /** The note line's text. */
  note(): string;
};

/** How long a note stays. */
const NOTE_MS = 4_000;

export type PanelElements = {
  stage: HTMLElement;
  tabs: HTMLElement;
  banner: HTMLElement;
  alert: HTMLElement;
  note: HTMLElement;
  /** The find bar: its input, and the pane it searches. */
  find: HTMLElement;
  findInput: HTMLInputElement;
};

/**
 * The panel's terminals (§10's xterm options, slice 1c's subset): `convertEol` false, the scrollback the mirror keeps,
 * Option as Option (not Meta), and Option-click forcing a selection; each fills its element and follows its size. And
 * its tabs and splits (§10): a tab strip of text titles, the active tab's split tree as nested flex boxes with draggable
 * dividers, a zoomed pane alone; panes of other tabs wait, still attached, in a hidden box. The banner, the note and the
 * titles show text only, never markup.
 */
export class XtermView implements TerminalView, LayoutView {
  private readonly stage: HTMLElement;
  private readonly tabsElement: HTMLElement;
  private readonly bannerElement: HTMLElement;
  private readonly alertElement: HTMLElement;
  private readonly noteElement: HTMLElement;
  /** Where the panes of other tabs wait: in the page, so their terminals keep parsing output, but not laid out. */
  private readonly parking: HTMLElement;
  private settings: TerminalSettings;
  private readonly terminals = new Map<string, Terminal>();
  private readonly held = new Map<string, Held>();
  private readonly findElement: HTMLElement;
  private readonly findInput: HTMLInputElement;
  /** The pane the find bar searches. */
  private finding: string | null = null;
  private menuElement: HTMLElement | null = null;
  private readonly elements = new Map<string, HTMLElement>();
  private shown: LayoutShown | null = null;
  /** The structure last built: the active tab, its zoom and its tree without ratios. */
  private built = "";
  private noteTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly selectListeners: ((tab: string) => void)[] = [];
  private readonly dragListeners: ((tab: string, path: SplitPath, ratio: number) => void)[] = [];
  /** In a test build, each pane's last 200 resets, writes (their length) and resizes, for the live suite's reports. */
  private readonly calls = new Map<string, string[]>();

  constructor(elements: PanelElements, settings: TerminalSettings) {
    this.stage = elements.stage;
    this.tabsElement = elements.tabs;
    this.bannerElement = elements.banner;
    this.alertElement = elements.alert;
    this.noteElement = elements.note;
    this.parking = document.createElement("div");
    this.parking.className = "parking";
    document.body.append(this.parking);
    this.settings = settings;
    this.findElement = elements.find;
    this.findInput = elements.findInput;
    this.findInput.addEventListener("input", () => this.search("incremental"));
    this.findInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.search(event.shiftKey ? "previous" : "next");
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.closeFind();
      }
    });
    document.addEventListener("pointerdown", (event) => {
      if (this.menuElement !== null && !(event.target instanceof Node && this.menuElement.contains(event.target))) this.closeMenu();
    });
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
        alert: () => (this.alertElement.hidden ? "" : (this.alertElement.textContent ?? "")),
        layout: () => this.shown,
        focused: () => {
          for (const [paneId, element] of this.elements) if (element.contains(document.activeElement)) return paneId;
          return null;
        },
        note: () => (this.noteElement.hidden ? "" : (this.noteElement.textContent ?? "")),
      };
      (globalThis as { deskTest?: TestHooks }).deskTest = hooks;
    }
  }

  create(paneId: string): TerminalPane {
    const element = document.createElement("div");
    element.className = "pane";
    this.parking.append(element);
    this.elements.set(paneId, element);
    const term = new Terminal({
      convertEol: false,
      scrollback: this.settings.scrollback,
      fontFamily: this.settings.fontFamily,
      fontSize: this.settings.fontSize,
      macOptionIsMeta: this.settings.macOptionIsMeta,
      macOptionClickForcesSelection: true,
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
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
    this.held.set(paneId, { term, fit, search, element, laidOut });
    const pasteListeners: ((text: string) => void)[] = [];
    const focusListeners: (() => void)[] = [];
    const keyListeners: ((input: KeyInput) => boolean)[] = [];
    const menuListeners: ((item: MenuItem) => void)[] = [];
    // Keys go to the panel first (§10): one it takes never reaches xterm, and nothing else is prevented.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const input: KeyInput = {
        code: event.code,
        meta: event.metaKey,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        composing: event.isComposing || event.keyCode === 229,
      };
      if (!keyListeners.some((listener) => listener(input))) return true;
      event.preventDefault();
      return false;
    });
    element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.openMenu(event.clientX, event.clientY, term, (text) => {
        for (const listener of pasteListeners) listener(text);
      }, (item) => {
        for (const listener of menuListeners) listener(item);
      });
    });
    element.addEventListener("focusin", () => {
      for (const listener of focusListeners) listener();
    });
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
      onFocus: (listener) => {
        focusListeners.push(listener);
      },
      onKey: (listener) => {
        keyListeners.push(listener);
      },
      onMenu: (listener) => {
        menuListeners.push(listener);
      },
      find: (command) => {
        if (command === "open" || this.findInput.value === "" || this.finding !== paneId) this.openFind(paneId);
        else this.search(command);
      },
      clear: () => term.clear(),
      focus: () => term.focus(),
      dispose: () => {
        observer.disconnect();
        this.terminals.delete(paneId);
        this.held.delete(paneId);
        if (this.finding === paneId) this.closeFind();
        this.elements.delete(paneId);
        term.dispose();
        element.remove();
      },
    };
  }

  configure(settings: TerminalSettings): void {
    this.settings = settings;
    for (const { term, fit, laidOut } of this.held.values()) {
      term.options.fontFamily = settings.fontFamily;
      term.options.fontSize = settings.fontSize;
      term.options.scrollback = settings.scrollback;
      term.options.macOptionIsMeta = settings.macOptionIsMeta;
      if (laidOut()) fit.fit();
    }
  }

  /** The find bar on `paneId`, its text selected so typing replaces it. */
  private openFind(paneId: string): void {
    this.finding = paneId;
    this.findElement.hidden = false;
    this.findInput.focus();
    this.findInput.select();
    if (this.findInput.value !== "") this.search("incremental");
  }

  private closeFind(): void {
    const paneId = this.finding;
    this.finding = null;
    this.findElement.hidden = true;
    const held = paneId === null ? undefined : this.held.get(paneId);
    held?.search.clearDecorations();
    held?.term.focus();
  }

  private search(how: "incremental" | "next" | "previous"): void {
    const held = this.finding === null ? undefined : this.held.get(this.finding);
    const query = this.findInput.value;
    if (held === undefined || query === "") return;
    if (how === "previous") held.search.findPrevious(query);
    else held.search.findNext(query, { incremental: how === "incremental" });
  }

  /** The pane's context menu (§10): Copy, Paste, Split right, Split down, Clear; text buttons only. */
  private openMenu(x: number, y: number, term: Terminal, paste: (text: string) => void, pick: (item: MenuItem) => void): void {
    this.closeMenu();
    const menu = document.createElement("div");
    menu.className = "menu";
    menu.setAttribute("role", "menu");
    const item = (label: string, run: () => void, enabled = true) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.disabled = !enabled;
      button.setAttribute("role", "menuitem");
      button.addEventListener("click", () => {
        this.closeMenu();
        run();
      });
      menu.append(button);
    };
    const selection = term.getSelection();
    item("Copy", () => void navigator.clipboard.writeText(selection).catch(() => this.note("Desk could not copy to the clipboard")), selection !== "");
    item("Paste", () => {
      navigator.clipboard.readText().then(paste, () => this.note("Desk could not read the clipboard: use Cmd+V"));
    });
    item("Split right", () => pick("split-right"));
    item("Split down", () => pick("split-down"));
    item("Clear", () => pick("clear"));
    menu.style.left = `${Math.min(x, window.innerWidth - 160)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 170)}px`;
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.closeMenu();
    });
    document.body.append(menu);
    this.menuElement = menu;
    menu.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }

  private closeMenu(): void {
    this.menuElement?.remove();
    this.menuElement = null;
  }

  show(shown: LayoutShown): void {
    this.shown = shown;
    this.showTabs(shown);
    const structure = JSON.stringify([shown.active, shown.zoomed, shown.root === null ? null : shape(shown.root)]);
    if (structure !== this.built) {
      this.built = structure;
      // Moving a pane's element takes the keyboard out of it: give it back to the element that had it.
      const had = document.activeElement;
      const root = shown.zoomed !== null ? (this.elements.get(shown.zoomed) ?? null) : shown.root === null ? null : this.build(shown.root, [], shown.active ?? "");
      const placed = new Set<HTMLElement>();
      if (root !== null) for (const element of [root, ...root.querySelectorAll<HTMLElement>(".pane")]) placed.add(element);
      for (const element of this.elements.values()) if (!placed.has(element)) this.parking.append(element);
      this.stage.replaceChildren(...(root === null ? [] : [root]));
      if (had instanceof HTMLElement && had.isConnected && had !== document.activeElement) had.focus();
    } else if (shown.root !== null) {
      this.ratios(shown.root, this.stage.firstElementChild);
    }
    for (const [paneId, element] of this.elements) element.classList.toggle("focused", paneId === shown.focus);
  }

  note(text: string): void {
    this.noteElement.textContent = text;
    this.noteElement.hidden = false;
    if (this.noteTimer !== null) clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => {
      this.noteElement.hidden = true;
    }, NOTE_MS);
  }

  onSelectTab(listener: (tab: string) => void): void {
    this.selectListeners.push(listener);
  }

  onDrag(listener: (tab: string, path: SplitPath, ratio: number) => void): void {
    this.dragListeners.push(listener);
  }

  /** The strip: one button per tab, its title as text; hidden while there is one tab. */
  private showTabs(shown: LayoutShown): void {
    const buttons = shown.tabs.map((tab) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tab";
      button.textContent = tab.title;
      button.classList.toggle("active", tab.id === shown.active);
      button.classList.toggle("marked", tab.marked);
      button.addEventListener("click", () => {
        for (const listener of this.selectListeners) listener(tab.id);
      });
      return button;
    });
    this.tabsElement.replaceChildren(...buttons);
    this.tabsElement.hidden = shown.tabs.length <= 1;
  }

  /** A split tree as nested flex boxes: each split a box of two parts and a divider between them. */
  private build(node: LayoutNode, path: SplitPath, tab: string): HTMLElement {
    if ("pane" in node) return this.elements.get(node.pane) ?? document.createElement("div");
    const box = document.createElement("div");
    box.className = `split ${node.split}`;
    const a = this.build(node.a, [...path, "a"], tab);
    const b = this.build(node.b, [...path, "b"], tab);
    a.style.flex = `${node.ratio} 1 0`;
    b.style.flex = `${1 - node.ratio} 1 0`;
    const divider = document.createElement("div");
    divider.className = "divider";
    divider.addEventListener("pointerdown", (event) => this.drag(event, box, a, b, node.split, tab, path));
    box.append(a, divider, b);
    return box;
  }

  /** The ratios of an unchanged structure, set on the boxes already built. */
  private ratios(node: LayoutNode, element: Element | null): void {
    if ("pane" in node || !(element instanceof HTMLElement)) return;
    const [a, , b] = [...element.children];
    if (!(a instanceof HTMLElement) || !(b instanceof HTMLElement)) return;
    a.style.flex = `${node.ratio} 1 0`;
    b.style.flex = `${1 - node.ratio} 1 0`;
    this.ratios(node.a, a);
    this.ratios(node.b, b);
  }

  /** Dragging a divider resizes the two parts as the pointer moves; the ratio is reported when it is let go. */
  private drag(start: PointerEvent, box: HTMLElement, a: HTMLElement, b: HTMLElement, split: "row" | "col", tab: string, path: SplitPath): void {
    start.preventDefault();
    const divider = start.currentTarget;
    if (!(divider instanceof HTMLElement)) return;
    divider.setPointerCapture(start.pointerId);
    let ratio: number | null = null;
    const move = (event: PointerEvent) => {
      const rect = box.getBoundingClientRect();
      const at = split === "row" ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height;
      ratio = Math.min(0.9, Math.max(0.1, at));
      a.style.flex = `${ratio} 1 0`;
      b.style.flex = `${1 - ratio} 1 0`;
    };
    const end = () => {
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", end);
      divider.removeEventListener("pointercancel", end);
      if (ratio !== null) for (const listener of this.dragListeners) listener(tab, path, ratio);
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", end);
    divider.addEventListener("pointercancel", end);
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

  alert(text: string): void {
    this.alertElement.textContent = text;
    this.alertElement.hidden = false;
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

/** A tree's shape without its ratios: a drag changes ratios, not what is built. */
function shape(node: LayoutNode): unknown {
  return "pane" in node ? node.pane : [node.split, shape(node.a), shape(node.b)];
}
