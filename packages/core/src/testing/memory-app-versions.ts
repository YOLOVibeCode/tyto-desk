import type { AppVersions, StageResult } from "../ports/app-versions.ts";

/** Installed versions in memory. A stage of `from` answers `runtimes[from]`; commits, discards and switches are recorded. */
export class MemoryAppVersions implements AppVersions {
  readonly installed: string[] = [];
  currentVersion: string | null = null;
  readonly runtimes = new Map<string, StageResult>();
  readonly committed: string[] = [];
  readonly discarded: string[] = [];
  readonly used: string[] = [];

  async list(): Promise<readonly string[]> {
    return [...this.installed];
  }

  async current(): Promise<string | null> {
    return this.currentVersion;
  }

  async stage(from: string): Promise<StageResult> {
    return this.runtimes.get(from) ?? { ok: false, reason: "no-version-json" };
  }

  async commit(staging: string, version: string): Promise<void> {
    this.committed.push(`${staging} -> ${version}`);
    this.installed.push(version);
  }

  async discard(staging: string): Promise<void> {
    this.discarded.push(staging);
  }

  async use(version: string): Promise<void> {
    if (!this.installed.includes(version)) throw new Error(`${version} is not installed`);
    this.used.push(version);
    this.currentVersion = version;
  }
}
