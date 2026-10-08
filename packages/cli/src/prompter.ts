import type { Consent, Picked, Picker, Prompter } from "@desk/core";

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
    const line = await readLine(this.stdin);
    return { ok: true, yes: /^(?:y|yes)$/i.test(line.trim()) };
  }
}

/** One line typed on stdin (or nothing, at its end). */
function readLine(stdin: NodeJS.ReadableStream): Promise<string> {
  return new Promise<string>((resolve) => {
    let typed = "";
    const onData = (chunk: Buffer | string) => {
      typed += chunk.toString();
      const newline = typed.indexOf("\n");
      if (newline !== -1) done(typed.slice(0, newline));
    };
    const onEnd = () => done("");
    const done = (answer: string) => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.pause();
      resolve(answer);
    };
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.resume();
  });
}

/**
 * A numbered list on a TTY (docs/IMPLEMENTATION.md §14 step 5): nothing is chosen until you type the numbers you want,
 * separated by spaces or commas; Enter alone chooses nothing, and a number not on the list chooses nothing.
 */
export class TtyPicker implements Picker {
  private readonly stdin: NodeJS.ReadableStream & Terminal;
  private readonly stdout: NodeJS.WritableStream & Terminal;

  constructor(stdin: NodeJS.ReadableStream & Terminal, stdout: NodeJS.WritableStream & Terminal) {
    this.stdin = stdin;
    this.stdout = stdout;
  }

  async pick(question: string, options: readonly string[]): Promise<Picked> {
    if (this.stdin.isTTY !== true || this.stdout.isTTY !== true) return { ok: false, reason: "no-tty" };
    this.stdout.write(`${question}\n`);
    options.forEach((option, index) => this.stdout.write(`  ${index + 1}. ${option}\n`));
    this.stdout.write("Numbers to choose (Enter for none): ");
    const parts = (await readLine(this.stdin)).split(/[\s,]+/).filter((part) => part !== "");
    const chosen = parts.map(Number);
    if (chosen.some((n) => !Number.isInteger(n) || n < 1 || n > options.length)) return { ok: true, chosen: [] };
    return { ok: true, chosen: [...new Set(chosen.map((n) => n - 1))] };
  }
}
