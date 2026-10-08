import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { TtyPicker, TtyPrompter } from "../src/index.ts";

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

describe("the TTY picker (docs/IMPLEMENTATION.md §14 step 5)", () => {
  const options = ["example.test (2 cookies)", "other.test (1 cookie)", "third.test (5 cookies)"];

  it("the picker refuses to ask without an interactive terminal", async () => {
    expect(await new TtyPicker(new PassThrough(), new PassThrough()).pick("Choose:", options)).toEqual({ ok: false, reason: "no-tty" });
  });

  it.each([
    ["\n", []],
    ["1 3\n", [0, 2]],
    ["2,2\n", [1]],
    ["1 9\n", []],
    ["one\n", []],
  ])("the picker reads %j as %j, so nothing is chosen unless you type it", async (answer, chosen) => {
    const { stdin, stdout, shown } = terminal(answer);

    expect(await new TtyPicker(stdin, stdout).pick("Choose:", options)).toEqual({ ok: true, chosen });
    expect(shown.join("")).toContain("  1. example.test (2 cookies)\n");
  });
});
