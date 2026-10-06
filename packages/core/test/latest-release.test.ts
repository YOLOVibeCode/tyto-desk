import { describe, expect, it } from "vitest";
import { isLatestRelease, releaseTagVersion } from "../src/index.ts";

describe("the latest-flag rule", () => {
  it.each([
    { version: "0.3.0", published: ["0.2.9", "0.1.0"], latest: true },
    { version: "0.3.0", published: [], latest: true },
    { version: "0.2.9", published: ["0.3.0", "0.1.0"], latest: false },
    { version: "0.10.0", published: ["0.9.9"], latest: true },
    { version: "1.0.0", published: ["1.0.0"], latest: true },
  ])(
    "a release becomes latest only when its version is the highest published ($version over $published)",
    ({ version, published, latest }) => {
      expect(isLatestRelease(version, published)).toBe(latest);
    },
  );

  it.each([
    ["v0.3.0", "0.3.0"],
    ["v10.20.30", "10.20.30"],
    ["v0.3", null],
    ["0.3.0", null],
    ["V0.3.0", null],
    ["v0.3.0-rc.1", null],
    ["v00.3.0", null],
    ["v0.3.0+build", null],
  ])("a release tag %s names version %s", (tag, version) => {
    expect(releaseTagVersion(tag)).toBe(version);
  });
});
