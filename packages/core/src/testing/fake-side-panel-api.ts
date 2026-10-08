import type { SidePanelApi } from "../ports/side-panel-api.ts";

/** Side panels the test opens and closes by window id. */
export class FakeSidePanelApi implements SidePanelApi {
  openOnAction = false;
  open: number[];
  readonly paths: string[] = [];
  readonly closes: number[] = [];
  /** Each `openInGesture`, in order. */
  readonly gestureOpens: number[] = [];
  private readonly opened: ((windowId: number) => void)[] = [];
  private readonly closed: ((windowId: number) => void)[] = [];

  constructor(open: number[] = []) {
    this.open = open;
  }

  async openOnActionClick(): Promise<void> {
    this.openOnAction = true;
  }

  async openWindows(): Promise<readonly number[]> {
    return [...this.open];
  }

  async setPath(path: string): Promise<void> {
    this.paths.push(path);
  }

  openInGesture(windowId: number): void {
    this.gestureOpens.push(windowId);
  }

  async close(windowId: number): Promise<void> {
    this.closes.push(windowId);
    this.hide(windowId);
  }

  onOpened(listener: (windowId: number) => void): void {
    this.opened.push(listener);
  }

  onClosed(listener: (windowId: number) => void): void {
    this.closed.push(listener);
  }

  /** Chrome shows the panel in a window. */
  show(windowId: number): void {
    this.open.push(windowId);
    for (const listener of this.opened) listener(windowId);
  }

  /** Chrome hides the panel in a window. */
  hide(windowId: number): void {
    this.open = this.open.filter((id) => id !== windowId);
    for (const listener of this.closed) listener(windowId);
  }
}
