import type { Consent, Prompter } from "@desk/core";

type Terminal = { isTTY?: boolean };

/**
 * Asks on the terminal (docs/IMPLEMENTATION.md §0 Consent): only when stdin and stdout are both a TTY, else it refuses
 * without asking. `y` or `yes` is yes; anything else, a closed terminal included, is no. There is no `--yes`.
 */
export class TtyPrompter implements Prompter {
  private readonly stdin: NodeJS.ReadableStream & Terminal;
  private readonly stdout: NodeJS.WritableStream & Terminal;

  constructor(stdin: NodeJS.ReadableStream & Terminal, stdout: NodeJS.WritableStream & Terminal) {
    this.stdin = stdin;
    this.stdout = stdout;
  }

  async confirm(question: string): Promise<Consent> {
    if (this.stdin.isTTY !== true || this.stdout.isTTY !== true) return { ok: false, reason: "no-tty" };
    this.stdout.write(`${question} [y/N] `);
    const line = await new Promise<string>((resolve) => {
      let typed = "";
      const onData = (chunk: Buffer | string) => {
        typed += chunk.toString();
        const newline = typed.indexOf("\n");
        if (newline !== -1) done(typed.slice(0, newline));
      };
      const onEnd = () => done("");
      const done = (answer: string) => {
        this.stdin.off("data", onData);
        this.stdin.off("end", onEnd);
        this.stdin.pause();
        resolve(answer);
      };
      this.stdin.on("data", onData);
      this.stdin.on("end", onEnd);
      this.stdin.resume();
    });
    return { ok: true, yes: /^(?:y|yes)$/i.test(line.trim()) };
  }
}
