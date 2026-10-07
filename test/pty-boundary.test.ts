import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ptyImportViolations } from "../scripts/lib/pty-boundary.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));

/** A checkout holding one file at `path` with `text`. */
async function checkoutWith(path: string, text: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pty-boundary-"));
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), text);
  return root;
}

describe("the PTY package stays out of the offline suite (docs/IMPLEMENTATION.md §17.1)", () => {
  it("nothing outside test/live/ and packages/*/test/live/ imports the PTY package", async () => {
    expect(await ptyImportViolations(repo)).toEqual([]);
  });

  it.each([
    ["a static import in a unit test", "test/pty.test.ts", 'import { spawn } from "@lydell/node-pty";\n'],
    ["a type-only import in an adapter test", "packages/node/test/pty.test.ts", 'import type { IPty } from "node-pty";\n'],
    ["a dynamic import in a script", "scripts/probe.mjs", 'await import("@lydell/node-pty");\n'],
    ["a require in a script", "scripts/probe.cjs", 'require("node-pty");\n'],
    ["a platform package re-exported from a source file", "packages/node/src/pty.ts", 'export * from "@lydell/node-pty-darwin-arm64";\n'],
    ["an import in a root config", "vitest.config.ts", 'import "node-pty";\n'],
  ])("the PTY boundary flags %s", async (_label, path, text) => {
    const root = await checkoutWith(path, text);

    expect(await ptyImportViolations(root)).toEqual([{ file: path, line: 1 }]);
  });

  it.each([
    ["the repo's live suite", "test/live/pty.test.ts"],
    ["an adapter's live suite", "packages/ptyd/test/live/pty.test.ts"],
  ])("the PTY boundary lets %s import the PTY package", async (_label, path) => {
    const root = await checkoutWith(path, 'import { spawn } from "@lydell/node-pty";\n');

    expect(await ptyImportViolations(root)).toEqual([]);
  });

  it("the PTY boundary ignores the package's name in comments and strings", async () => {
    const root = await checkoutWith("test/notes.test.ts", '// see "@lydell/node-pty"\nconst name = "node-pty";\n');

    expect(await ptyImportViolations(root)).toEqual([]);
  });
});
