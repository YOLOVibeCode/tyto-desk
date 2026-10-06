import type { Random } from "../ports/random.ts";

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** Deterministic `Random`: `int` cycles through `values` (folded into the range); ids count up from 1. */
export class SeqRandom implements Random {
  private readonly values: readonly number[];
  private next = 0;
  private issued = 0;

  constructor(values: readonly number[]) {
    this.values = values;
  }

  int(min: number, max: number): number {
    const value = this.values.length === 0 ? 0 : (this.values[this.next % this.values.length] ?? 0);
    this.next += 1;
    return min + (Math.abs(Math.trunc(value)) % (max - min + 1));
  }

  id(prefix: string): string {
    this.issued += 1;
    let n = this.issued;
    let digits = "";
    for (let i = 0; i < 10; i += 1) {
      digits = (CROCKFORD[n % 32] ?? "0") + digits;
      n = Math.floor(n / 32);
    }
    return `${prefix}_${digits}`;
  }
}
