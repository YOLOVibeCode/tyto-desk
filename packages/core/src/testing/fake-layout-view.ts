import type { SplitPath } from "../layout/layout.ts";
import type { LayoutShown, LayoutView } from "../ports/layout-view.ts";

/** Everything the panel showed and noted, and the tab picks and drags the test makes. */
export class FakeLayoutView implements LayoutView {
  readonly shown: LayoutShown[] = [];
  readonly notes: string[] = [];
  private readonly selectListeners: ((tab: string) => void)[] = [];
  private readonly dragListeners: ((tab: string, path: SplitPath, ratio: number) => void)[] = [];

  show(shown: LayoutShown): void {
    this.shown.push(shown);
  }

  note(text: string): void {
    this.notes.push(text);
  }

  onSelectTab(listener: (tab: string) => void): void {
    this.selectListeners.push(listener);
  }

  onDrag(listener: (tab: string, path: SplitPath, ratio: number) => void): void {
    this.dragListeners.push(listener);
  }

  /** What the panel shows now, failing the test when it showed nothing. */
  last(): LayoutShown {
    const shown = this.shown.at(-1);
    if (shown === undefined) throw new Error("the panel showed no layout");
    return shown;
  }

  /** The user picks a tab. */
  userSelects(tab: string): void {
    for (const listener of this.selectListeners) listener(tab);
  }

  /** The user drags a divider. */
  userDrags(tab: string, path: SplitPath, ratio: number): void {
    for (const listener of this.dragListeners) listener(tab, path, ratio);
  }
}
