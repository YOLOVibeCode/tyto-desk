/**
 * What the autofill probe saw (docs/IMPLEMENTATION.md §15.2, M17): Chrome held a saved password until your screen lock,
 * filled it without asking, had none saved on the probe page, or the probe could not run.
 */
export type AutofillVerdict = "held-for-screen-lock" | "filled-without-screen-lock" | "not-saved" | "unavailable";

/**
 * `desk doctor`'s checks against the running Desk Chrome (§15.2). Adapter: packages/cli: `autofill` serves a local login
 * page in a background tab, asks you to save a throwaway password there, then opens it again over CDP and sees whether
 * Chrome filled it before your screen lock.
 */
export interface SecurityProbe {
  autofill(): Promise<AutofillVerdict>;
}
