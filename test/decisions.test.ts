import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decisionNumbers, decisionProblems } from "../scripts/lib/decisions.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));

/** A plan with a §22 table holding `rows`, between the sections around it in docs/IMPLEMENTATION.md. */
function plan(rows: string[]): string {
  return [
    "## 21. Unverified register",
    "",
    "| D9 | a row of another section's table |",
    "",
    "## 22. Decisions",
    "",
    "| # | Decision | Why |",
    "|---|---|---|",
    ...rows.map((row) => `| ${row} | a decision | a reason |`),
    "",
    "## 23. Delivery",
    "",
    "| D1 | a row after §22 |",
  ].join("\n");
}

describe("the decisions in docs/IMPLEMENTATION.md §22", () => {
  it("the §22 decision numbers in docs/IMPLEMENTATION.md are unique and strictly increasing", async () => {
    const numbers = decisionNumbers(await readFile(`${repo}docs/IMPLEMENTATION.md`, "utf8"));

    expect(numbers.length).toBeGreaterThan(80);
    expect(numbers[0]).toBe(1);
    expect(decisionProblems(numbers)).toEqual([]);
  });

  it("the decision numbers are read from §22's table rows only", () => {
    expect(decisionNumbers(plan(["D1", "D2", "D10"]))).toEqual([1, 2, 10]);
  });

  it.each([
    ["a repeated number", ["D1", "D2", "D2"], ["D2 repeats D2"]],
    ["a number lower than the one before it", ["D1", "D3", "D2"], ["D2 follows D3"]],
    ["a repeat after a gap", ["D1", "D5", "D7", "D5"], ["D5 follows D7"]],
  ])("the decision check refuses %s", (_label, rows, problems) => {
    expect(decisionProblems(decisionNumbers(plan(rows)))).toEqual(problems);
  });

  it("the decision check refuses a plan without a §22 table", () => {
    expect(() => decisionNumbers("## 22. Decisions\n\nNo table.\n")).toThrow(/no decision rows/);
  });
});
