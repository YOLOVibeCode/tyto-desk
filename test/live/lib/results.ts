import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where the live suite leaves what it measured, screenshots and Chrome's logs: /home/lab/results in the container
 * (DESK_LIVE_RESULTS), which scripts/live.mjs copies into test-results/live/ (gitignored) with docker cp. Fixture values
 * only: nothing here comes from the operator's accounts.
 */
export function resultsDir(): string {
  return process.env.DESK_LIVE_RESULTS ?? join(tmpdir(), "desk-live-results");
}

/** Writes `<name>.json`. */
export async function saveResult(name: string, data: unknown): Promise<void> {
  await mkdir(resultsDir(), { recursive: true });
  await writeFile(join(resultsDir(), `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
}

/** Writes `<name>.png` from a CDP `Page.captureScreenshot` answer. */
export async function saveScreenshot(name: string, base64: string): Promise<void> {
  await mkdir(resultsDir(), { recursive: true });
  await writeFile(join(resultsDir(), `${name}.png`), Buffer.from(base64, "base64"));
}
