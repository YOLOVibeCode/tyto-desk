import type { Clock } from "../ports/clock.ts";

/**
 * Asks `probe` until it returns something other than `null`, every `intervalMs`, for at most `budgetMs`; the observed
 * condition decides, never the wait. Returns what the probe saw, or `null` when the budget ran out.
 */
export async function pollUntil<T>(clock: Clock, budgetMs: number, intervalMs: number, probe: () => Promise<T | null>): Promise<T | null> {
  const deadline = clock.now() + budgetMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    const left = deadline - clock.now();
    if (left <= 0) return null;
    await clock.sleep(Math.min(intervalMs, left));
  }
}
