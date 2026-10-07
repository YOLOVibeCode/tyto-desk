import { defineConfig } from "vitest/config";

// The default suite is offline: no browser, no Chrome binary, no network, no PTY, no keys.
// Live tests live in packages/*/test/live/ and test/live/ and run only inside the Desk test container
// (npm run test:live, slice 1b), never here.
// test/setup/global-setup.ts gives every run a fresh HOME, DESK_HOME and TMPDIR, and fails the run if the
// real ~/.desk changed.
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "packages/*/test/live/**", "test/live/**"],
    environment: "node",
    // Tests that start processes or scan the whole repository take 1–3 s each, and up to 5.4 s on a Mac whose load
    // average sits above 20 (2026-10-07), past Vitest's default 5 s. 15 s still stops a hung test long before the suite
    // would notice, and the whole suite stays well under SPEC §8's 30 s.
    testTimeout: 15_000,
    globalSetup: ["test/setup/global-setup.ts"],
    reporters: ["default"],
  },
});
