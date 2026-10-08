import type { Picked, Picker } from "../ports/picker.ts";

/** Answers each pick as scripted, and records the questions and options shown. */
export class ScriptedPicker implements Picker {
  readonly shown: { question: string; options: readonly string[] }[] = [];
  private readonly answers: (readonly number[] | "no-tty")[];

  constructor(answers: (readonly number[] | "no-tty")[]) {
    this.answers = answers;
  }

  async pick(question: string, options: readonly string[]): Promise<Picked> {
    this.shown.push({ question, options });
    const answer = this.answers.shift() ?? [];
    return answer === "no-tty" ? { ok: false, reason: "no-tty" } : { ok: true, chosen: answer };
  }
}
