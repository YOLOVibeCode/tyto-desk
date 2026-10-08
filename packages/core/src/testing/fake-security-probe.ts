import type { AutofillVerdict, SecurityProbe } from "../ports/security-probe.ts";

/** The probe's verdict as the test sets it, and how often it ran. */
export class FakeSecurityProbe implements SecurityProbe {
  verdict: AutofillVerdict = "held-for-screen-lock";
  runs = 0;

  async autofill(): Promise<AutofillVerdict> {
    this.runs += 1;
    return this.verdict;
  }
}
