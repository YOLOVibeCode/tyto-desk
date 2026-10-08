import type { DeskBrowser } from "../ports/desk-browser.ts";

/** The Desk Chrome as the test sets it; how often it was asked for. */
export class FakeDeskBrowser implements DeskBrowser {
  value: { port: number; wsUrl: string } | null;
  ensured = 0;

  constructor(value: { port: number; wsUrl: string } | null) {
    this.value = value;
  }

  async ensure(): Promise<{ port: number; wsUrl: string } | null> {
    this.ensured += 1;
    return this.value;
  }
}
