import type { ChromeProfile } from "../ports/chrome-profile.ts";

/** A profile with an optional SingletonLock and Default/Preferences; seeds are recorded. */
export class FakeChromeProfile implements ChromeProfile {
  lock: { host: string; pid: number } | null;
  preferencesExist: boolean;
  readonly seeded: Readonly<Record<string, unknown>>[] = [];

  constructor(options: { lock?: { host: string; pid: number } | null; preferencesExist?: boolean } = {}) {
    this.lock = options.lock ?? null;
    this.preferencesExist = options.preferencesExist ?? false;
  }

  async singleton(): Promise<{ host: string; pid: number } | null> {
    return this.lock;
  }

  async seedFirstRun(prefs: Readonly<Record<string, unknown>>): Promise<boolean> {
    if (this.preferencesExist) return false;
    this.seeded.push(prefs);
    this.preferencesExist = true;
    return true;
  }
}
