import { AGENT_BROWSER_CONFIG_FILE, agentBrowserConfig, cdpUrl } from "../agents/agent-browser.ts";
import { pollUntil } from "../launch/poll.ts";
import { ensureWatch, type WatchStartPorts } from "../launch/watch-start.ts";
import type { DaemonCommand } from "../nmhost/host.ts";
import type { ConfigStore } from "../ports/config-store.ts";
import type { PortProbe } from "../ports/port-probe.ts";
import type { Random } from "../ports/random.ts";
import type { TextFiles } from "../ports/text-files.ts";
import { allocateDeskPort } from "./allocate.ts";

export type NewPortPorts = WatchStartPorts & { config: ConfigStore; probe: PortProbe; random: Random; files: TextFiles };

const LAUNCH_LOCK_MS = 10_000;
const POLL_MS = 100;

/**
 * `desk config new-port` (SPEC §4): a new free guarded-endpoint port, under `run/launch.lock` so no `desk` starts
 * meanwhile. It saves the config, rewrites `agent-browser.json` (whose path panes already hold, so agent-browser follows
 * at once), and replaces a running `desk watch` so the endpoint moves now. Running shells keep their `DESK_CDP_URL`.
 */
export async function newGuardedPort(
  ports: NewPortPorts,
  input: { deskHome: string; version: string; watchCommand: DaemonCommand },
): Promise<{ code: 0 | 65 | 75; message: string }> {
  const lock = await pollUntil(ports.clock, LAUNCH_LOCK_MS, POLL_MS, async () => {
    const attempt = await ports.lock.acquire("launch");
    return attempt.ok ? attempt : null;
  });
  if (lock === null) return { code: 75, message: "another desk is starting the Desk Chrome; run desk config new-port again once it is ready" };
  try {
    const config = await ports.config.load();
    if (config === null) return { code: 65, message: "Desk has no config yet; run desk first" };
    const old = config.gateway.port;
    const port = await allocateDeskPort(ports.probe, ports.random, [config.chrome.port, old]);
    if (port === null) return { code: 75, message: "no other port from 9400 to 9899 is free for the guarded endpoint" };
    const moved = { ...config, gateway: { ...config.gateway, port } };
    await ports.config.save(moved);
    await ports.files.write(`${input.deskHome}/${AGENT_BROWSER_CONFIG_FILE}`, `${JSON.stringify(agentBrowserConfig({ config: moved, deskHome: input.deskHome }), null, 2)}\n`, 0o600);
    if ((await ports.lock.holder("watch")) !== null) {
      await ensureWatch(ports, { command: input.watchCommand, version: input.version, replace: true });
    }
    return {
      code: 0,
      message:
        `The guarded endpoint moved from port ${old} to port ${port}. agent-browser follows it now; running tmux sessions keep ` +
        `DESK_CDP_URL=${cdpUrl(old)} until you restart them, and new panes get ${cdpUrl(port)}`,
    };
  } finally {
    await lock.release();
  }
}
