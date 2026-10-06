import type { PortProbe } from "../ports/port-probe.ts";
import type { Random } from "../ports/random.ts";
import { DESK_PORT_MAX, DESK_PORT_MIN } from "./schema.ts";

/**
 * Two distinct ports from 9400–9899 that the probe finds free: candidates in a random order (Fisher–Yates over the
 * whole range), each probed at most once. `null` when fewer than two are free.
 */
export async function allocateDeskPorts(probe: PortProbe, random: Random): Promise<readonly [number, number] | null> {
  const candidates: number[] = [];
  for (let port = DESK_PORT_MIN; port <= DESK_PORT_MAX; port += 1) candidates.push(port);
  for (let i = candidates.length - 1; i > 0; i -= 1) {
    const j = random.int(0, i);
    const a = candidates[i];
    const b = candidates[j];
    if (a === undefined || b === undefined) throw new RangeError("Random.int returned a value outside the range");
    candidates[i] = b;
    candidates[j] = a;
  }
  let first: number | null = null;
  for (const port of candidates) {
    if (!(await probe.isFree(port))) continue;
    if (first === null) first = port;
    else return [first, port];
  }
  return null;
}
