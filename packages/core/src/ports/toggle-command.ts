/**
 * The toggle shortcut (docs/IMPLEMENTATION.md §10, `toggle-terminal` in the manifest): the window it was pressed in.
 * Adapter: packages/extension (`chrome.commands.onCommand`), registered while the worker starts, before any await.
 */
export interface ToggleCommand {
  onToggle(listener: (windowId: number) => void): void;
}
