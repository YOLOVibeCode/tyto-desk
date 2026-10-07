import { join } from "node:path";
import { parseDeskConfig, serializeDeskConfig, type ConfigProblem, type ConfigStore, type DeskConfig } from "@desk/core";
import { readIfExists, writePrivate } from "./files.ts";

/** config.json was refused: what is wrong and where, never the file's text. */
export class ConfigFileError extends Error {
  override name = "ConfigFileError";
  readonly problem: ConfigProblem;
  readonly path: string;

  constructor(problem: ConfigProblem, path: string) {
    super(`config.json is not valid: ${problem}${path === "" ? "" : ` at ${path}`}`);
    this.problem = problem;
    this.path = path;
  }
}

/** `~/.desk/config.json` (docs/IMPLEMENTATION.md §4.1): 0600, written atomically, read strictly. */
export class FileConfigStore implements ConfigStore {
  private readonly path: string;

  constructor(deskHome: string) {
    this.path = join(deskHome, "config.json");
  }

  async load(): Promise<DeskConfig | null> {
    const text = await readIfExists(this.path);
    if (text === null) return null;
    const parsed = parseDeskConfig(text);
    if (!parsed.ok) throw new ConfigFileError(parsed.problem, parsed.path);
    return parsed.config;
  }

  async save(config: DeskConfig): Promise<void> {
    await writePrivate(this.path, serializeDeskConfig(config));
  }
}
