import type { CodeSigning } from "../ports/code-signing.ts";

/** Signatures in memory: bundles in `valid` verify; signings are recorded. */
export class FakeCodeSigning implements CodeSigning {
  readonly valid = new Set<string>();
  readonly signed: { bundle: string; identifier: string }[] = [];
  readonly verified: string[] = [];

  async adHocSign(bundle: string, identifier: string): Promise<boolean> {
    this.signed.push({ bundle, identifier });
    this.valid.add(bundle);
    return true;
  }

  async verify(bundle: string): Promise<boolean> {
    this.verified.push(bundle);
    return this.valid.has(bundle);
  }
}
