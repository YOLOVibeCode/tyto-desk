import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { TtyPrompter } from "../src/index.ts";

/** A stream pair that claims to be a terminal, as stdin and stdout are in an interactive shell. */
function terminal(answer: string | null) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stdout = Object.assign(new PassThrough(), { isTTY: true });
  const shown: string[] = [];
  stdout.on("data", (chunk: Buffer) => shown.push(chunk.toString("utf8")));
  if (answer !== null) setTimeout(() => stdin.write(answer), 5);
  return { stdin, stdout, shown };
}

describe("the TTY prompter", () => {
  it("the prompter refuses to ask without an interactive terminal", async () => {
    const prompter = new TtyPrompter(new PassThrough(), new PassThrough());

    expect(await prompter.confirm("Make Desk 0.3.0 current?")).toEqual({ ok: false, reason: "no-tty" });
  });

  it.each([
    ["y\n", true],
    ["yes\n", true],
    ["Y\n", true],
    ["n\n", false],
    ["\n", false],
    ["sure\n", false],
  ])("the prompter reads %j as %s", async (answer, yes) => {
    const { stdin, stdout, shown } = terminal(answer);

    expect(await new TtyPrompter(stdin, stdout).confirm("Make Desk 0.3.0 current?")).toEqual({ ok: true, yes });
    expect(shown.join("")).toContain("Make Desk 0.3.0 current? [y/N] ");
  });

  it("the prompter takes a closed terminal as no", async () => {
    const { stdin, stdout } = terminal(null);
    setTimeout(() => stdin.end(), 5);

    expect(await new TtyPrompter(stdin, stdout).confirm("Make Desk 0.3.0 current?")).toEqual({ ok: true, yes: false });
  });
});
