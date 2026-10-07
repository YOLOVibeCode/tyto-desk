import type { PanelQuestions } from "../ports/panel-questions.ts";

/** A panel the test loads: `ask` returns the worker's answer, or `null` when the worker set none. */
export class FakePanelQuestions implements PanelQuestions {
  private answer: (() => boolean) | null = null;

  onFocusAsked(answer: () => boolean): void {
    this.answer = answer;
  }

  ask(): boolean | null {
    return this.answer === null ? null : this.answer();
  }
}
