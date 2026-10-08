import { spawn } from "node:child_process";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeProcessCwd } from "../src/index.ts";

describe("a process's working directory", () => {
  it("NodeProcessCwd reads the directory a running process is in", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "cwd-")));
    const child = spawn("/bin/sleep", ["5"], { cwd: dir, stdio: "ignore" });
    try {
      const cwd = await new NodeProcessCwd().cwdOf(child.pid ?? -1);

      expect(cwd === null ? null : await realpath(cwd)).toBe(dir);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("NodeProcessCwd gives null for a process that is gone", async () => {
    expect(await new NodeProcessCwd().cwdOf(2 ** 22 + 7)).toBeNull();
  });
});
