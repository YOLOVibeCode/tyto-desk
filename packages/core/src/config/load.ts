import type { ConfigStore } from "../ports/config-store.ts";
import type { PortProbe } from "../ports/port-probe.ts";
import type { Random } from "../ports/random.ts";
import { allocateDeskPorts } from "./allocate.ts";
import { newDeskConfig, platformSupported } from "./defaults.ts";
import type { DeskConfig } from "./schema.ts";

export type LoadOrCreateInput = {
  store: ConfigStore;
  probe: PortProbe;
  random: Random;
  home: string;
  platform: string;
};

export type LoadOrCreateResult =
  | { ok: true; created: boolean; config: DeskConfig }
  | { ok: false; code: "no-free-ports" | "unsupported-platform" };

/**
 * The saved config, unchanged and without probing; on first run a new one with two free ports, saved before it is
 * returned (docs/IMPLEMENTATION.md §6.1 step 2). The caller holds `run/launch.lock`.
 */
export async function loadOrCreateConfig(input: LoadOrCreateInput): Promise<LoadOrCreateResult> {
  const saved = await input.store.load();
  if (saved !== null) return { ok: true, created: false, config: saved };
  if (!platformSupported(input.platform)) return { ok: false, code: "unsupported-platform" };
  const ports = await allocateDeskPorts(input.probe, input.random);
  if (ports === null) return { ok: false, code: "no-free-ports" };
  const config = newDeskConfig({ home: input.home, platform: input.platform, chromePort: ports[0], gatewayPort: ports[1] });
  await input.store.save(config);
  return { ok: true, created: true, config };
}
