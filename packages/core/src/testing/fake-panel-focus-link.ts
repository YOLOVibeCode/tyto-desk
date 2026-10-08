import type { PanelFocusLink } from "../ports/panel-focus-link.ts";

/** Panel focus reports the test makes, and the focus requests the worker sent. */
export class FakePanelFocusLink implements PanelFocusLink {
  readonly focused: number[] = [];
  private readonly listeners: ((windowId: number, focused: boolean) => void)[] = [];

  onReport(listener: (windowId: number, focused: boolean) => void): void {
    this.listeners.push(listener);
  }

  focus(windowId: number): void {
    this.focused.push(windowId);
  }

  /** A panel says it gained or lost the keyboard. */
  report(windowId: number, focused: boolean): void {
    for (const listener of this.listeners) listener(windowId, focused);
  }
}
