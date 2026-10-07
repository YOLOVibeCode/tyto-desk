import { join } from "node:path";
import { daemonEnvironment, newGuardedPort, terminalBinary } from "@desk/core";
import { CryptoRandom, FileConfigStore, NodeDetachedSpawner, NodeInstanceLock, NodePortProbe, NodeProcessSignals, NodeTextFiles, SystemClock } from "@desk/node";
import type { CommandResult } from "./install.ts";

/** `desk config new-port`: core's plan over the Node adapters; a running `desk watch` is replaced by this version's. */
export async function newPortCommand(input: { env: NodeJS.ProcessEnv; platform: string; deskHome: string; version: string; appDir: string }): Promise<CommandResult> {
  return newGuardedPort(
    {
      config: new FileConfigStore(input.deskHome),
      probe: new NodePortProbe(),
      random: new CryptoRandom(),
      files: new NodeTextFiles(),
      lock: new NodeInstanceLock(join(input.deskHome, "run")),
      signals: new NodeProcessSignals(),
      spawner: new NodeDetachedSpawner(),
      clock: new SystemClock(),
    },
    {
      deskHome: input.deskHome,
      version: input.version,
      watchCommand: {
        file: join(input.appDir, terminalBinary(input.platform)),
        args: [join(input.appDir, "desk.mjs"), "watch"],
        env: { ...daemonEnvironment(input.env), DESK_HOME: input.deskHome },
      },
    },
  );
}
