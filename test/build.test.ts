import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_CHROME_SWITCHES, FORBIDDEN_CHROME_SWITCH_VALUES } from "../packages/core/src/index.ts";
import { buildBundles, spelledForbiddenSwitches } from "../scripts/lib/build.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));

function spelled(text: string) {
  return spelledForbiddenSwitches([{ path: "x.js", text }], FORBIDDEN_CHROME_SWITCHES, FORBIDDEN_CHROME_SWITCH_VALUES);
}

describe("build", () => {
  it("the build bundles core for a neutral platform", async () => {
    const bundles = await buildBundles(repo);

    expect(bundles.map((bundle) => bundle.path)).toEqual(["core/index.js", "core/testing/index.js"]);
  });

  it("no production module spells a forbidden Chrome switch", async () => {
    const bundles = await buildBundles(repo);

    expect(spelledForbiddenSwitches(bundles, FORBIDDEN_CHROME_SWITCHES, FORBIDDEN_CHROME_SWITCH_VALUES)).toEqual([]);
  });

  it.each([
    'args.push("--enable-automation");',
    "const a = ['-headless=new'];",
    'run("--remote-debugging-port=0")',
    'run("--enable-blink-features=CSSAnchorPositioning,AutomationControlled")',
    "const a = ['--password-store=basic'];",
  ])("the build refuses a bundle that spells %s", (text) => {
    expect(spelled(text)).toHaveLength(1);
  });

  it.each([
    "[`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`]",
    'run("--enable-blink-features=CSSAnchorPositioning", "--password-store=gnome-libsecret")',
  ])("the build accepts %s", (text) => {
    expect(spelled(text)).toEqual([]);
  });
});
