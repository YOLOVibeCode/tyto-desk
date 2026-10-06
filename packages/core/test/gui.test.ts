import { describe, expect, it } from "vitest";
import { guiAllowed } from "../src/index.ts";

describe("guiAllowed", () => {
  it.each([
    { label: "the installed launcher", env: { DESK_ALLOW_GUI: "1" }, platform: "darwin", allowed: true },
    { label: "a plain shell", env: {}, platform: "darwin", allowed: false },
    { label: "another DESK_ALLOW_GUI value", env: { DESK_ALLOW_GUI: "true" }, platform: "darwin", allowed: false },
    { label: "DESK_ALLOW_GUI=1 under Vitest", env: { DESK_ALLOW_GUI: "1", VITEST: "true" }, platform: "darwin", allowed: false },
    { label: "VITEST set to anything", env: { DESK_ALLOW_GUI: "1", VITEST: "" }, platform: "darwin", allowed: false },
    { label: "DESK_NO_GUI=1 and DESK_ALLOW_GUI=1", env: { DESK_ALLOW_GUI: "1", DESK_NO_GUI: "1" }, platform: "darwin", allowed: false },
    { label: "the Linux test container", env: { DESK_IN_CONTAINER: "1" }, platform: "linux", allowed: true },
    { label: "the container under Vitest", env: { DESK_IN_CONTAINER: "1", VITEST: "true" }, platform: "linux", allowed: true },
    { label: "DESK_IN_CONTAINER=1 on a Mac", env: { DESK_IN_CONTAINER: "1", VITEST: "true" }, platform: "darwin", allowed: false },
    { label: "DESK_NO_GUI=1 in the container", env: { DESK_IN_CONTAINER: "1", DESK_NO_GUI: "1" }, platform: "linux", allowed: false },
    { label: "DESK_NO_GUI=true and DESK_ALLOW_GUI=1", env: { DESK_ALLOW_GUI: "1", DESK_NO_GUI: "true" }, platform: "darwin", allowed: false },
    { label: "DESK_NO_GUI=yes and DESK_ALLOW_GUI=1", env: { DESK_ALLOW_GUI: "1", DESK_NO_GUI: "yes" }, platform: "darwin", allowed: false },
    { label: "DESK_NO_GUI=true in the container", env: { DESK_IN_CONTAINER: "1", DESK_NO_GUI: "true" }, platform: "linux", allowed: false },
    { label: "DESK_NO_GUI=0, which turns the kill switch off", env: { DESK_ALLOW_GUI: "1", DESK_NO_GUI: "0" }, platform: "darwin", allowed: true },
    { label: "an empty DESK_NO_GUI", env: { DESK_ALLOW_GUI: "1", DESK_NO_GUI: "" }, platform: "darwin", allowed: true },
    { label: "Linux under Vitest", env: { VITEST: "true" }, platform: "linux", allowed: false },
  ])(
    "guiAllowed is true only with DESK_ALLOW_GUI=1 outside tests, or inside the Linux test container ($label)",
    ({ env, platform, allowed }) => {
      expect(guiAllowed(env, platform)).toBe(allowed);
    },
  );
});
