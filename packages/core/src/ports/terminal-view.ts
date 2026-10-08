/** A terminal's size in character cells. */
export type TerminalSize = { cols: number; rows: number };

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
  create(paneId: string): TerminalPane;
  /** Shows a line above the terminal, with a button when `action` is given, or hides it with `null`. */
  banner(text: string | null, action?: BannerAction): void;
  /** Asks the user a yes-or-no question in the panel ("Paste 3 lines?"). */
  confirm(question: string): Promise<boolean>;
  /** Shows an alert from `desk watch` on a red line of its own, which no banner hides (§9). */
  alert(text: string): void;
}
