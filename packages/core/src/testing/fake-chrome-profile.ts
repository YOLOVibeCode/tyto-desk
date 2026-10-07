import type { ChromeProfile } from "../ports/chrome-profile.ts";

/** A profile with an optional SingletonLock, Default/Preferences and Local State; seeds are recorded. */
export class FakeChromeProfile implements ChromeProfile {
  lock: { host: string; pid: number } | null;
  preferencesExist: boolean;
  localState: Record<string, unknown> = {};
  readonly seeded: Readonly<Record<string, unknown>>[] = [];

  constructor(options: { lock?: { host: string; pid: number } | null; preferencesExist?: boolean } = {}) {
    this.lock = options.lock ?? null;
    this.preferencesExist = options.preferencesExist ?? false;
  }

  async singleton(): Promise<{ host: string; pid: number } | null> {
    return this.lock;
  }

  async localStatePref(path: string): Promise<unknown> {
    let value: unknown = this.localState;
    for (const key of path.split(".")) {
      if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return undefined;
      value = (value as Record<string, unknown>)[key];
    }
    return value;
  }

  async seedFirstRun(prefs: Readonly<Record<string, unknown>>): Promise<boolean> {
    if (this.preferencesExist) return false;
    this.seeded.push(prefs);
    this.preferencesExist = true;
    return true;
  }
}
