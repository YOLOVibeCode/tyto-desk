import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { daemonEnvironment, startHost, terminalBinary, type DaemonCommand } from "@desk/core";
import { NodeDetachedSpawner, SystemClock } from "@desk/node";
import { UnixDaemonDialer } from "./dialer.ts";
import { relay } from "./relay.ts";

/**
 * `desk-nmhost` (docs/IMPLEMENTATION.md §8), which Chrome starts for the Desk extension with the caller's origin as its
 * first argument. Any other origin ends it before it contacts anything. It reaches the daemon, starting the current
 * version's when the socket is dead (resolving `~/.desk/app/current` once, so it never starts an old one), then relays
 * until either side goes away.
 */
export async function runHost(input: {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  deskHome: string;
  platform: string;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const daemonCommand = async (): Promise<DaemonCommand | null> => {
    const version = await realpath(join(input.deskHome, "app", "current")).catch(() => null);
    if (version === null) return null;
    return {
      file: join(version, terminalBinary(input.platform)),
      args: [join(version, "desk.mjs"), "ptyd"],
      env: { ...daemonEnvironment(input.env), DESK_HOME: input.deskHome },
    };
  };
  const started = await startHost({
    origin: input.argv[0],
    dialer: new UnixDaemonDialer(join(input.deskHome, "run", "ptyd.sock")),
    spawner: new NodeDetachedSpawner(),
    clock: new SystemClock(),
    daemonCommand,
  });
  if (!started.ok) return 1;
  return relay({ stdin: input.stdin, stdout: input.stdout, socket: started.link });
}
