import { describe, expect, it } from "vitest";
import { confirmToQuitOn } from "../src/index.ts";

describe("Chrome's Local State", () => {
  it("doctor treats a missing confirm_to_quit in Local State as on", () => {
    expect(confirmToQuitOn(undefined)).toBe(true);
  });

  it.each([
    [true, true],
    [false, false],
    ["false", true],
    [null, true],
  ])("confirm_to_quit %j reads as %s, as Chrome reads it", (value, on) => {
    expect(confirmToQuitOn(value)).toBe(on);
  });
});
