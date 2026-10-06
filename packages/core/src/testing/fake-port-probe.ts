import type { PortProbe } from "../ports/port-probe.ts";

/** Ports in `busy` are taken; every probe is recorded in order. */
export class FakePortProbe implements PortProbe {
  readonly busy: Set<number>;
  readonly probed: number[] = [];

  constructor(busy: Iterable<number> = []) {
    this.busy = new Set(busy);
  }

  async isFree(port: number): Promise<boolean> {
    this.probed.push(port);
    return !this.busy.has(port);
  }
}
