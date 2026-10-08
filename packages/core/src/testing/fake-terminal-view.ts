import type { BannerAction, TerminalPane, TerminalSize, TerminalView } from "../ports/terminal-view.ts";

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
  private readonly size: TerminalSize;

  constructor(size: TerminalSize = { cols: 100, rows: 30 }) {
    this.size = size;
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
