import { suiteRefusal } from "../../../scripts/lib/live.mjs";

/**
 * The live suite's first global setup: it refuses to run anywhere but the Linux test container, before any test file
 * is loaded. On the Mac it would start Chrome on the operator's screen; there, `npm run test:live` drives the Colima VM
 * instead (docs/IMPLEMENTATION.md §17.3).
 */
export function setup(): void {
  const refusal = suiteRefusal({ platform: process.platform, env: process.env });
  if (refusal !== null) throw new Error(refusal);
}
