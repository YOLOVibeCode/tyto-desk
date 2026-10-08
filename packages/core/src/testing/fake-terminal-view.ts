import type { BannerAction, KeyInput, MenuItem, TerminalPane, TerminalSettings, TerminalSize, TerminalView } from "../ports/terminal-view.ts";

/** A pane's terminal in memory: what was written since the last reset, and input the test types. */
export class FakeTerminalPane implements TerminalPane {
  readonly id: string;
  screen = "";
  resets = 0;
  focuses = 0;
  disposed = false;
  current: TerminalSize;
  readonly pastes: string[] = [];
  bracketed = true;
  private readonly pasteListeners: ((text: string) => void)[] = [];
  private readonly inputListeners: ((data: string) => void)[] = [];
  private readonly resizeListeners: ((size: TerminalSize) => void)[] = [];
  private readonly focusListeners: (() => void)[] = [];
  private readonly keyListeners: ((input: KeyInput) => boolean)[] = [];
  private readonly menuListeners: ((item: MenuItem) => void)[] = [];
  /** The find bar commands the panel gave this pane. */
  readonly finds: string[] = [];
  clears = 0;

  constructor(id: string, size: TerminalSize) {
    this.id = id;
    this.current = size;
  }

  write(data: string, done?: () => void): void {
    this.screen += data;
    done?.();
  }

  paste(text: string): void {
    this.pastes.push(text);
  }

  bracketedPasteMode(): boolean {
    return this.bracketed;
  }

  onPaste(listener: (text: string) => void): void {
    this.pasteListeners.push(listener);
  }

  /** The user pastes `text`. */
  userPastes(text: string): void {
    for (const listener of this.pasteListeners) listener(text);
  }

  reset(): void {
    this.screen = "";
    this.resets += 1;
  }

  size(): TerminalSize {
    return this.current;
  }

  onInput(listener: (data: string) => void): void {
    this.inputListeners.push(listener);
  }

  onResize(listener: (size: TerminalSize) => void): void {
    this.resizeListeners.push(listener);
  }

  onFocus(listener: () => void): void {
    this.focusListeners.push(listener);
  }

  onKey(listener: (input: KeyInput) => boolean): void {
    this.keyListeners.push(listener);
  }

  onMenu(listener: (item: MenuItem) => void): void {
    this.menuListeners.push(listener);
  }

  find(command: "open" | "next" | "previous"): void {
    this.finds.push(command);
  }

  clear(): void {
    this.clears += 1;
  }

  /** The user presses a key; true when the panel took it, so the terminal never sees it. */
  presses(input: Partial<KeyInput> & { code: string }): boolean {
    const full: KeyInput = { meta: false, ctrl: false, alt: false, shift: false, composing: false, ...input };
    return this.keyListeners.some((listener) => listener(full));
  }

  /** The user picks an item from this pane's context menu. */
  picks(item: MenuItem): void {
    for (const listener of this.menuListeners) listener(item);
  }

  focus(): void {
    this.focuses += 1;
  }

  /** The user clicks into this pane. */
  userFocuses(): void {
    for (const listener of this.focusListeners) listener();
  }

  dispose(): void {
    this.disposed = true;
  }

  /** The user types. */
  type(data: string): void {
    for (const listener of this.inputListeners) listener(data);
  }

  /** The panel is resized to `size`. */
  resize(size: TerminalSize): void {
    this.current = size;
    for (const listener of this.resizeListeners) listener(size);
  }
}

/** The panel's terminals by pane id, and its banner. */
export class FakeTerminalView implements TerminalView {
  readonly panes: FakeTerminalPane[] = [];
  bannerText: string | null = null;
  bannerAction: BannerAction | null = null;
  /** The questions the panel asked, and the answers the test gives, in order (no answer means no). */
  readonly questions: string[] = [];
  readonly answers: boolean[] = [];
  alertText: string | null = null;
  /** Every configure, in order. */
  readonly settings: TerminalSettings[] = [];
  private readonly size: TerminalSize;

  constructor(size: TerminalSize = { cols: 100, rows: 30 }) {
    this.size = size;
  }

  configure(settings: TerminalSettings): void {
    this.settings.push(settings);
  }

  create(paneId: string): FakeTerminalPane {
    const pane = new FakeTerminalPane(paneId, this.size);
    this.panes.push(pane);
    return pane;
  }

  alert(text: string): void {
    this.alertText = text;
  }

  banner(text: string | null, action?: BannerAction): void {
    this.bannerText = text;
    this.bannerAction = action ?? null;
  }

  async confirm(question: string): Promise<boolean> {
    this.questions.push(question);
    return this.answers.shift() ?? false;
  }

  /** The live terminal of `paneId`, failing the test when there is none. */
  of(paneId: string): FakeTerminalPane {
    const pane = this.panes.filter((p) => p.id === paneId && !p.disposed).at(-1);
    if (pane === undefined) throw new Error(`the panel has no terminal for ${paneId}`);
    return pane;
  }

  /** The latest pane, failing the test when there is none. */
  pane(): FakeTerminalPane {
    const pane = this.panes.at(-1);
    if (pane === undefined) throw new Error("the panel made no terminal");
    return pane;
  }
}
