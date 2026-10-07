import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryLogSink } from "@desk/core/testing";
import { FileLogSink, logCrashes } from "../src/index.ts";

async function logsDir(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "logs-")), "logs");
}

describe("the logs (docs/IMPLEMENTATION.md §4.4)", () => {
  it("FileLogSink appends one JSON event per line to a 0600 file in a 0700 directory", async () => {
    const dir = await logsDir();
    const sink = new FileLogSink(join(dir, "ptyd.log"));

    sink.write({ event: "bad-line", size: 12 });
    sink.write({ event: "shutdown", mode: "stop" });
    await sink.flushed();

    expect((await readFile(join(dir, "ptyd.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { at: expect.any(String), event: "bad-line", size: 12 },
      { at: expect.any(String), event: "shutdown", mode: "stop" },
    ]);
    expect((await stat(join(dir, "ptyd.log"))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("FileLogSink keeps at most three files of about 1 MB each", async () => {
    const dir = await logsDir();
    const sink = new FileLogSink(join(dir, "ptyd.log"), { maxBytes: 200 });

    for (let i = 0; i < 40; i += 1) sink.write({ event: "bad-line", size: i });
    await sink.flushed();

    expect((await readdir(dir)).sort()).toEqual(["ptyd.log", "ptyd.log.1", "ptyd.log.2"]);
    for (const name of await readdir(dir)) expect((await stat(join(dir, name))).size).toBeLessThanOrEqual(200);
  });

  it("FileLogSink runs the Redactor on every string it writes", async () => {
    const dir = await logsDir();
    const sink = new FileLogSink(join(dir, "desk.log"));
    // A fake token in GitHub's shape, assembled here so the repository's own secret scan has nothing to flag.
    const token = ["ghp", "_", "a1b2c3d4e5".repeat(4)].join("");

    sink.write({ event: "crash", errorClass: token, code: null });
    await sink.flushed();

    expect(await readFile(join(dir, "desk.log"), "utf8")).not.toContain(token);
  });

  it("an uncaught exception in a Desk process logs only its class and code", () => {
    const processLike = new EventEmitter();
    const sink = new MemoryLogSink();
    const exits: number[] = [];
    logCrashes(processLike, sink, (code) => exits.push(code));
    const error = Object.assign(new TypeError("desk-canary-token: the pane said so"), { code: "ERR_CANARY" });

    processLike.emit("uncaughtException", error);
    processLike.emit("unhandledRejection", new RangeError("desk-canary-rejection"));
    processLike.emit("warning", Object.assign(new Error("desk-canary-warning"), { name: "DeprecationWarning" }));

    expect(sink.events).toEqual([
      { event: "crash", errorClass: "TypeError", code: "ERR_CANARY" },
      { event: "crash", errorClass: "RangeError", code: null },
      { event: "warning", errorClass: "DeprecationWarning", code: null },
    ]);
    expect(JSON.stringify(sink.events)).not.toContain("canary");
    expect(exits).toEqual([70, 70]);
  });
});
