import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_CHROME_SWITCHES } from "../packages/core/src/index.ts";
import { buildBundles, spelledForbiddenSwitches } from "../scripts/lib/build.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));

describe("build", () => {
  it("the build bundles core for a neutral platform", async () => {
    const bundles = await buildBundles(repo);

    expect(bundles.map((bundle) => bundle.path)).toEqual(["core/index.js", "core/testing/index.js"]);
  });

  it("no production module spells a forbidden Chrome switch", async () => {
    const bundles = await buildBundles(repo);

    expect(spelledForbiddenSwitches(bundles, FORBIDDEN_CHROME_SWITCHES)).toEqual([]);
  });

  it.each(['args.push("--enable-automation");', "const a = ['-headless=new'];", 'run("--remote-debugging-port=0")'])(
    "the build refuses a bundle that spells %s",
    (text) => {
      expect(spelledForbiddenSwitches([{ path: "x.js", text }], FORBIDDEN_CHROME_SWITCHES)).toHaveLength(1);
    },
  );

  it("the build accepts the Desk-owned port and profile switches chromeArgs writes", () => {
    const text = "[`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`]";

    expect(spelledForbiddenSwitches([{ path: "x.js", text }], FORBIDDEN_CHROME_SWITCHES)).toEqual([]);
  });
});
