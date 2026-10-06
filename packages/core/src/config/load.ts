import type { ConfigStore } from "../ports/config-store.ts";
import type { PortProbe } from "../ports/port-probe.ts";
import type { Random } from "../ports/random.ts";
import { allocateDeskPorts } from "./allocate.ts";
import { newDeskConfig, platformSupported } from "./defaults.ts";
import { DESK_PORT_MIN, parseDeskConfig, serializeDeskConfig, type DeskConfig } from "./schema.ts";

export type LoadOrCreateInput = {
  store: ConfigStore;
  probe: PortProbe;
  random: Random;
  home: string;
  platform: string;
};

/**
 * - `unsupported-platform`: Desk has no defaults for this platform.
 * - `bad-home`: the home is not absolute, is the root directory, or gives a config the schema would refuse.
 * - `no-free-ports`: fewer than two ports in 9400–9899 are free.
 */
export type LoadOrCreateResult =
  | { ok: true; created: boolean; config: DeskConfig }
  | { ok: false; code: "no-free-ports" | "unsupported-platform" | "bad-home" };

/** Desk puts its profile under the home, so the root directory (a system location) and relative paths are refused. */
function usableHome(home: string): boolean {
  return home.replace(/\/+$/, "").startsWith("/");
}

/** Whether a config made for `home` would load again: the schema is the judge, so the two cannot drift apart. */
function loadsAgain(config: DeskConfig): boolean {
  return parseDeskConfig(serializeDeskConfig(config)).ok;
}

/**
 * The saved config, unchanged and without probing; on first run a new one with two free ports, saved before it is
 * returned (docs/IMPLEMENTATION.md §6.1 step 2). A home that would give a config the schema refuses is reported before
 * any port is probed, and nothing is saved. The caller holds `run/launch.lock`.
 */
export async function loadOrCreateConfig(input: LoadOrCreateInput): Promise<LoadOrCreateResult> {
  const saved = await input.store.load();
  if (saved !== null) return { ok: true, created: false, config: saved };
  if (!platformSupported(input.platform)) return { ok: false, code: "unsupported-platform" };
  const draft = { home: input.home, platform: input.platform };
  if (!usableHome(input.home) || !loadsAgain(newDeskConfig({ ...draft, chromePort: DESK_PORT_MIN, gatewayPort: DESK_PORT_MIN + 1 }))) {
    return { ok: false, code: "bad-home" };
  }
  const ports = await allocateDeskPorts(input.probe, input.random);
  if (ports === null) return { ok: false, code: "no-free-ports" };
  const config = newDeskConfig({ ...draft, chromePort: ports[0], gatewayPort: ports[1] });
  await input.store.save(config);
  return { ok: true, created: true, config };
}
