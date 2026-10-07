import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DAEMON_ENTRY, PTY_ADAPTER, ptyImportViolations } from "../scripts/lib/pty-boundary.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));

/** A checkout holding each file at its path with its text. */
async function checkoutWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pty-boundary-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

describe("the PTY package stays out of the offline suite (docs/IMPLEMENTATION.md §17.1)", () => {
  it("nothing outside the live suites and the daemon's PTY adapter imports the PTY package, and nothing but the daemon reaches that adapter", async () => {
    expect(await ptyImportViolations(repo)).toEqual([]);
  });

  it("the daemon's PTY adapter and entry are the files the boundary names", () => {
    expect([PTY_ADAPTER, DAEMON_ENTRY]).toEqual(["packages/ptyd/src/node-pty-spawner.ts", "packages/ptyd/src/main.ts"]);
  });

  it.each([
    ["a static import in a unit test", "test/pty.test.ts", 'import { spawn } from "@lydell/node-pty";\n'],
    ["a type-only import in an adapter test", "packages/node/test/pty.test.ts", 'import type { IPty } from "node-pty";\n'],
    ["a dynamic import in a script", "scripts/probe.mjs", 'await import("@lydell/node-pty");\n'],
    ["a require in a script", "scripts/probe.cjs", 'require("node-pty");\n'],
    ["a platform package re-exported from a source file", "packages/node/src/pty.ts", 'export * from "@lydell/node-pty-darwin-arm64";\n'],
    ["an import in a root config", "vitest.config.ts", 'import "node-pty";\n'],
    ["an import in the daemon's other source files", "packages/ptyd/src/message-server.ts", 'import { spawn } from "@lydell/node-pty";\n'],
  ])("the PTY boundary flags %s", async (_label, path, text) => {
    const root = await checkoutWith({ [path]: text });

    expect(await ptyImportViolations(root)).toEqual([{ file: path, line: 1 }]);
  });

  it.each([
    ["the repo's live suite", "test/live/pty.test.ts"],
    ["an adapter's live suite", "packages/ptyd/test/live/pty.test.ts"],
    ["the daemon's PTY adapter", "packages/ptyd/src/node-pty-spawner.ts"],
  ])("the PTY boundary lets %s import the PTY package", async (_label, path) => {
    const root = await checkoutWith({ [path]: 'import { spawn } from "@lydell/node-pty";\n' });

    expect(await ptyImportViolations(root)).toEqual([]);
  });

  it.each([
    ["the daemon's index re-exporting it", "packages/ptyd/src/index.ts", 'export { NodePtySpawner } from "./node-pty-spawner.ts";\n'],
    ["an offline test", "packages/ptyd/test/spawner.test.ts", 'import { NodePtySpawner } from "../src/node-pty-spawner.ts";\n'],
    ["the CLI", "packages/cli/src/main.ts", 'const pty = await import("../../ptyd/src/node-pty-spawner.ts");\n'],
  ])("the PTY boundary flags the PTY adapter imported by %s", async (_label, path, text) => {
    const root = await checkoutWith({ [path]: text });

    expect(await ptyImportViolations(root)).toEqual([{ file: path, line: 1 }]);
  });

  it.each([
    ["a static import from the CLI", "packages/cli/src/main.ts", 'import { runDaemon } from "@desk/ptyd/main";\n'],
    ["a static relative import", "packages/cli/src/commands.ts", 'import { runDaemon } from "../../ptyd/src/main.ts";\n'],
    ["a dynamic import from an offline test", "packages/cli/test/main.test.ts", 'await import("@desk/ptyd/main");\n'],
    ["a dynamic import from a script", "scripts/run-daemon.mjs", 'await import("../packages/ptyd/src/main.ts");\n'],
  ])("the PTY boundary flags the daemon's entry reached by %s", async (_label, path, text) => {
    const root = await checkoutWith({ [path]: text });

    expect(await ptyImportViolations(root)).toEqual([{ file: path, line: 1 }]);
  });

  it("the PTY boundary lets the CLI reach the daemon's entry with a dynamic import, which only the ptyd command runs", async () => {
    const root = await checkoutWith({
      "packages/cli/src/main.ts": 'if (command === "ptyd") await import("@desk/ptyd/main");\n',
      "packages/ptyd/src/main.ts": 'import { NodePtySpawner } from "./node-pty-spawner.ts";\n',
      "packages/ptyd/src/node-pty-spawner.ts": 'import { spawn } from "@lydell/node-pty";\n',
    });

    expect(await ptyImportViolations(root)).toEqual([]);
  });

  it("the PTY boundary ignores the package's name in comments and strings", async () => {
    const root = await checkoutWith({ "test/notes.test.ts": '// see "@lydell/node-pty"\nconst name = "node-pty";\n' });

    expect(await ptyImportViolations(root)).toEqual([]);
  });
});
