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
    globalSetup: ["test/setup/global-setup.ts"],
    reporters: ["default"],
  },
});
