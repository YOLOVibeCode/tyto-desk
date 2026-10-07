import type { Consent, Prompter } from "../ports/prompter.ts";

/** Answers each question with the next scripted answer (`no-tty`: there is no interactive terminal); records them. */
export class ScriptedPrompter implements Prompter {
  readonly asked: string[] = [];
  private readonly answers: (boolean | "no-tty")[];

  constructor(answers: (boolean | "no-tty")[]) {
    this.answers = answers;
  }

  async confirm(question: string): Promise<Consent> {
    this.asked.push(question);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error(`ScriptedPrompter has no answer for: ${question}`);
    return answer === "no-tty" ? { ok: false, reason: "no-tty" } : { ok: true, yes: answer };
  }
}
