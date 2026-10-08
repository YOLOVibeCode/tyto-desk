import type { AppVersions, StageResult } from "../ports/app-versions.ts";

/** Installed versions in memory. A stage of `from` answers `runtimes[from]`; commits, discards and switches are recorded. */
export class MemoryAppVersions implements AppVersions {
  readonly installed: string[] = [];
  currentVersion: string | null = null;
  readonly runtimes = new Map<string, StageResult>();
  /** Each installed version's build id; a version without one has no files.sha256. */
  readonly builds = new Map<string, string>();
  readonly committed: string[] = [];
  readonly discarded: string[] = [];
  readonly used: string[] = [];
  /** Installed versions whose files no longer match their files.sha256. */
  readonly damaged = new Set<string>();

  async list(): Promise<readonly string[]> {
    return [...this.installed];
  }

  async current(): Promise<string | null> {
    return this.currentVersion;
  }

  async build(version: string): Promise<string | null> {
    return this.installed.includes(version) ? (this.builds.get(version) ?? null) : null;
  }

  async stage(from: string): Promise<StageResult> {
    return this.runtimes.get(from) ?? { ok: false, reason: "no-version-json" };
  }

  async commit(staging: string, version: string): Promise<void> {
    this.committed.push(`${staging} -> ${version}`);
    this.installed.push(version);
    const staged = [...this.runtimes.values()].find((result) => result.ok && result.staging === staging);
    if (staged?.ok === true) this.builds.set(version, staged.build);
  }

  async discard(staging: string): Promise<void> {
    this.discarded.push(staging);
  }

  async verify(version: string): Promise<boolean> {
    return this.installed.includes(version) && this.builds.has(version) && !this.damaged.has(version);
  }

  async use(version: string): Promise<void> {
    if (!this.installed.includes(version)) throw new Error(`${version} is not installed`);
    this.used.push(version);
    this.currentVersion = version;
  }
}
