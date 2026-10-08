/** A terminal's size in character cells. */
export type TerminalSize = { cols: number; rows: number };

/** A keydown as the panel sees it: the physical key (`KeyboardEvent.code`) and the modifiers held. */
export type KeyInput = { code: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean; composing: boolean };

/** What the pane's context menu offers besides Copy and Paste, which the view does itself (§10). */
export type MenuItem = "split-right" | "split-down" | "clear";

/** The settings every terminal takes (§10's xterm options from `config.json`, the font size from `layout.json`). */
export type TerminalSettings = { fontFamily: string; fontSize: number; scrollback: number; macOptionIsMeta: boolean };

/** One pane's terminal on the panel's page. */
export type TerminalPane = {
  /** Writes `data`; `done` runs once the terminal has parsed it (flow control acks count those, §7.3). */
  write(data: string, done?: () => void): void;
  /** Pastes text the panel already sanitized; the terminal adds the bracketed-paste markers when the program asked. */
  paste(text: string): void;
  /** Whether the program in the terminal turned on bracketed paste. */
  bracketedPasteMode(): boolean;
  /** Text the user pasted or dropped, before the terminal sees it (§10). */
  onPaste(listener: (text: string) => void): void;
  /** Clears the screen, scrollback and modes, as before a snapshot. */
  reset(): void;
  size(): TerminalSize;
  onInput(listener: (data: string) => void): void;
  onResize(listener: (size: TerminalSize) => void): void;
  /** The user moved the keyboard into this pane (a click, or Tab into it). */
  onFocus(listener: () => void): void;
  /** Each keydown before the terminal sees it; a listener that returns true took it (the terminal never sees it). */
  onKey(listener: (input: KeyInput) => boolean): void;
  /** An item the user picked from the pane's context menu. */
  onMenu(listener: (item: MenuItem) => void): void;
  /** The find bar on this pane: open it, or find the next or previous match of what it holds. */
  find(command: "open" | "next" | "previous"): void;
  /** Clears the scrollback, keeping the line the cursor is on. */
  clear(): void;
  focus(): void;
  dispose(): void;
};

/** A button beside the banner's text: "Restart now" (§9). */
export type BannerAction = { label: string; run(): void };

/**
 * The panel's terminals and its banner (docs/IMPLEMENTATION.md §3, §9). Adapter: packages/extension (xterm). Text in
 * the banner is shown as text, never as markup.
 */
export interface TerminalView {
  /** The settings for every terminal, those made already and those to come. */
  configure(settings: TerminalSettings): void;
  create(paneId: string): TerminalPane;
  /** Shows a line above the terminal, with a button when `action` is given, or hides it with `null`. */
  banner(text: string | null, action?: BannerAction): void;
  /** Asks the user a yes-or-no question in the panel ("Paste 3 lines?"). */
  confirm(question: string): Promise<boolean>;
  /** Shows an alert from `desk watch` on a red line of its own, which no banner hides (§9). */
  alert(text: string): void;
}
