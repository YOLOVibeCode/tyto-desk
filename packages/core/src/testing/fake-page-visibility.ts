import type { PageVisibility } from "../ports/page-visibility.ts";

/** A page the test hides and shows. */
export class FakePageVisibility implements PageVisibility {
  private readonly listeners: ((state: "visible" | "hidden") => void)[] = [];

  onChange(listener: (state: "visible" | "hidden") => void): void {
    this.listeners.push(listener);
  }

  change(state: "visible" | "hidden"): void {
    for (const listener of this.listeners) listener(state);
  }
}
