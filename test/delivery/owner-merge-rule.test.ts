import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repo } from "./helpers.ts";
import { ruleGaps } from "./owner-merge-rule.ts";

/** A file of the repository, as text. */
async function text(file: string): Promise<string> {
  return readFile(join(repo, file), "utf8");
}

/** From the first line that starts with `from` up to, not including, the next line that starts with `to`. */
function between(source: string, from: string, to: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trimStart().startsWith(from));
  if (start === -1) return "";
  const end = lines.findIndex((line, i) => i > start && line.trimStart().startsWith(to));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

const places = [
  {
    place: "IMPLEMENTATION D81",
    quotes: true,
    read: async () => (await text("docs/IMPLEMENTATION.md")).split("\n").find((line) => line.startsWith("| D81 |")) ?? "",
  },
  { place: "IMPLEMENTATION §23.1", quotes: true, read: async () => between(await text("docs/IMPLEMENTATION.md"), "### 23.1", "### 23.2") },
  { place: "IMPLEMENTATION §20", quotes: false, read: async () => between(await text("docs/IMPLEMENTATION.md"), "## 20.", "## 21.") },
  { place: "CONTRIBUTING rule 6", quotes: true, read: async () => between(await text("docs/CONTRIBUTING.md"), "6. Never turn on the auto-merge", "7. ") },
  { place: "CLAUDE.md", quotes: true, read: async () => between(await text("CLAUDE.md"), "## Pull requests and releases", "## Stack") },
  { place: "AGENTS.md", quotes: true, read: async () => between(await text("AGENTS.md"), "9. **Pull requests and releases**", "10. ") },
];

describe("the owner-merge rule", () => {
  it.each(places)("the owner-merge rule in $place states the owner's decision and every condition of it", async ({ read, quotes }) => {
    const rule = await read();

    expect(rule).not.toBe("");
    expect(ruleGaps(rule, { quotes })).toEqual([]);
  });
});
