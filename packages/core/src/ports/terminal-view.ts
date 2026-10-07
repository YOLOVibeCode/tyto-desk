/** A terminal's size in character cells. */
export type TerminalSize = { cols: number; rows: number };

/** One pane's terminal on the panel's page. */
export type TerminalPane = {
  write(data: string): void;
  /** Clears the screen, scrollback and modes, as before a snapshot. */
  reset(): void;
  size(): TerminalSize;
  onInput(listener: (data: string) => void): void;
  onResize(listener: (size: TerminalSize) => void): void;
  focus(): void;
  dispose(): void;
};

/**
 * The panel's terminals and its banner (docs/IMPLEMENTATION.md §3, §9). Adapter: packages/extension (xterm). Text in
 * the banner is shown as text, never as markup.
 */
export interface TerminalView {
  create(paneId: string): TerminalPane;
  /** Shows a line above the terminal, or hides it with `null`. */
  banner(text: string | null): void;
}
