import { join } from "node:path";
import { FileLogSink, logCrashes } from "@desk/node";
import { serveDaemon } from "./daemon-process.ts";
import { NodePtySpawner } from "./node-pty-spawner.ts";

/**
 * `desk-ptyd` (docs/IMPLEMENTATION.md §7.1; slice 1c: one daemon, panes without a mirror). Started only by a native
 * host, detached, with stdio ignored and an explicit environment. Its process logic is `serveDaemon`
 * (daemon-process.ts), which the offline suite tests; this entry adds the one thing it never loads: the PTY package.
 */
export async function runDaemon(input: { deskHome: string; env: NodeJS.ProcessEnv; version: string }): Promise<number> {
  const log = new FileLogSink(join(input.deskHome, "logs", "ptyd.log"));
  logCrashes(process, log, (code) => {
    void log.flushed().then(() => process.exit(code));
  });
  return serveDaemon({
    ...input,
    log,
    spawner: new NodePtySpawner(),
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    umask: (mask) => process.umask(mask),
    signals: process,
  });
}
