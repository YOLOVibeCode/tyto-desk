/** The Desk profile's Chrome-owned files Desk reads, and its one first-run write (docs/IMPLEMENTATION.md §3, §5). */
export interface ChromeProfile {
  /** `SingletonLock`'s `<host>-<pid>`, or `null` when there is none. */
  singleton(): Promise<{ host: string; pid: number } | null>;
  /** `profile.exit_type` from `Default/Preferences` (`Normal`, `Crashed`, …), or `null` when it or the file is missing. */
  exitType(): Promise<string | null>;
  /** Removes `SingletonLock`, `SingletonCookie` and `SingletonSocket` (a stale lock another host name left, §6.1 step 4). */
  clearStaleSingleton(): Promise<void>;
  /** The value at a dotted path in `Local State` (`browser.confirm_to_quit`); `undefined` when it or the file is missing. */
  localStatePref(path: string): Promise<unknown>;
  /** Writes the first-run prefs as `Default/Preferences`; `false`, writing nothing, when that file exists. */
  seedFirstRun(prefs: Readonly<Record<string, unknown>>): Promise<boolean>;
}
