import type { Badge } from "../ports/badge.ts";

/** The badge's text, and every change to it. */
export class FakeBadge implements Badge {
  text: string | null = null;
  readonly changes: (string | null)[] = [];

  set(text: string | null): void {
    this.text = text;
    this.changes.push(text);
  }
}
