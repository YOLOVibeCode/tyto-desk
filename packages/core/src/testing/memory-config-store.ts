import type { DeskConfig } from "../config/schema.ts";
import type { ConfigStore } from "../ports/config-store.ts";

/** Holds the config in memory and records every save. */
export class MemoryConfigStore implements ConfigStore {
  config: DeskConfig | null;
  readonly saved: DeskConfig[] = [];

  constructor(config: DeskConfig | null = null) {
    this.config = config;
  }

  async load(): Promise<DeskConfig | null> {
    return this.config;
  }

  async save(config: DeskConfig): Promise<void> {
    this.saved.push(config);
    this.config = config;
  }
}
