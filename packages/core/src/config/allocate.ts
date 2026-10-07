import type { PortProbe } from "../ports/port-probe.ts";
import type { Random } from "../ports/random.ts";
import { DESK_PORT_MAX, DESK_PORT_MIN } from "./schema.ts";

/** Every port in 9400–9899 in a random order (Fisher–Yates over the whole range). */
function shuffledDeskPorts(random: Random): number[] {
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
  return candidates;
}

/**
 * Two distinct ports from 9400–9899 that the probe finds free: candidates in a random order, each probed at most once.
 * `null` when fewer than two are free.
 */
export async function allocateDeskPorts(probe: PortProbe, random: Random): Promise<readonly [number, number] | null> {
  let first: number | null = null;
  for (const port of shuffledDeskPorts(random)) {
    if (!(await probe.isFree(port))) continue;
    if (first === null) first = port;
    else return [first, port];
  }
  return null;
}

/** One free port from 9400–9899 that is none of `avoid` (the ports Desk already uses), or `null`. */
export async function allocateDeskPort(probe: PortProbe, random: Random, avoid: readonly number[]): Promise<number | null> {
  for (const port of shuffledDeskPorts(random)) {
    if (avoid.includes(port)) continue;
    if (await probe.isFree(port)) return port;
  }
  return null;
}
