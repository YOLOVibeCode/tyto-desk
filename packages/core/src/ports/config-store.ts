import type { DeskConfig } from "../config/schema.ts";

/** `~/.desk/config.json` (0600, written atomically). Adapter: packages/node. */
export interface ConfigStore {
  /** The saved config, or `null` when there is none yet. */
  load(): Promise<DeskConfig | null>;
  save(config: DeskConfig): Promise<void>;
}
