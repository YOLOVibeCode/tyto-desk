/** The Desk profile's Chrome-owned files Desk reads, and its one first-run write (docs/IMPLEMENTATION.md §3, §5). */
export interface ChromeProfile {
  /** `SingletonLock`'s `<host>-<pid>`, or `null` when there is none. */
  singleton(): Promise<{ host: string; pid: number } | null>;
  /** Writes the first-run prefs as `Default/Preferences`; `false`, writing nothing, when that file exists. */
  seedFirstRun(prefs: Readonly<Record<string, unknown>>): Promise<boolean>;
}
