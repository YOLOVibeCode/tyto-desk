import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// The live suite (docs/IMPLEMENTATION.md §17.3). It runs only inside the Desk test container in the Colima VM, which
// `npm run test:live` (scripts/live.mjs) starts; test/live/setup/container-guard.ts refuses anywhere else, before any
// test file loads. test/setup/global-setup.ts still gives the run a fresh HOME, DESK_HOME and TMPDIR.
// One file at a time: each starts its own Chrome or PTYs, and the container has 3 CPUs.
// The container sets DESK_LIVE_RESULTS; without it (a refused run on the Mac) nothing is written anywhere.
const results = process.env.DESK_LIVE_RESULTS;

export default defineConfig({
  // The dependency volume is mounted read-only, so Vite's cache cannot live in node_modules/.vite.
  cacheDir: join(tmpdir(), "desk-live-vite"),
  test: {
    include: ["packages/*/test/live/**/*.test.ts", "test/live/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    environment: "node",
    globalSetup: ["test/live/setup/container-guard.ts", "test/setup/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 90_000,
    ...(results === undefined
      ? { reporters: ["default"] }
      : { reporters: ["default", "json"], outputFile: { json: join(results, "vitest.json") } }),
  },
});
