import type { OperatorOutput } from "../ports/operator-output.ts";

/** Every line said. */
export class MemoryOperatorOutput implements OperatorOutput {
  readonly lines: string[] = [];

  say(line: string): void {
    this.lines.push(line);
  }
}
