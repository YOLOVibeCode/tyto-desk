import type { ToggleCommand } from "../ports/toggle-command.ts";

/** The shortcut, pressed when the test says. */
export class FakeToggleCommand implements ToggleCommand {
  private readonly listeners: ((windowId: number) => void)[] = [];

  onToggle(listener: (windowId: number) => void): void {
    this.listeners.push(listener);
  }

  /** The user presses the toggle shortcut in a window. */
  press(windowId: number): void {
    for (const listener of this.listeners) listener(windowId);
  }
}
