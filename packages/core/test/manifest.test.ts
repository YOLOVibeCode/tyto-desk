import { describe, expect, it } from "vitest";
import {
  DESK_EXTENSION_ID,
  DESK_EXTENSION_ORIGIN,
  extensionIdFromKey,
  nextRenderState,
  parseRenderState,
  renderManifest,
  serializeRenderState,
  type RenderState,
} from "../src/index.ts";

/** A template shaped like packages/extension/manifest.json, with a fixture key that is not Desk's. */
const KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAj+EK4Sn+O8APY7SOhIYZy+HrlwEgBmaRFCHkAqe2fcpszEnoJrmmw5TKoFN9amT7Cbt22sZmyVkVh8keBCGGATL0LTTuQTe8jJbquInHgQN4cDNbw39FYBXw+++ghpmMEPMfLvbi+jMWm+ENzQqka2hhef+nhZtjZmeaoyfvnvt5euDC7XxtlANS7vyTpgdn5nTrj8TF34sRwbNcppfUvlDafZ7qtUTTw8mo3hJMdg7K3zF/gLQei0J6rqU8Jn/FMD2GCpngepvYaPcVd72zCKjBerKEqQXQvUJEo/uEho5ZW153NkYTjckCUKEC9aSAYmnBXfvN57wvRlqFMDhVLQIDAQAB";

function template(): Record<string, unknown> {
  return {
    manifest_version: 3,
    name: "Tyto Desk",
    version: "0.0.0",
    minimum_chrome_version: "155",
    key: KEY,
    commands: {
      "toggle-terminal": {
        suggested_key: { mac: "Command+Shift+Period", default: "Ctrl+Shift+Period" },
        description: "Show, focus, or hide the Desk terminal",
      },
    },
  };
}

describe("the Desk extension's manifest", () => {
  it("the Desk extension's id is the one its manifest key derives, and its origin names it", () => {
    expect(DESK_EXTENSION_ID).toMatch(/^[a-p]{32}$/);
    expect(DESK_EXTENSION_ORIGIN).toBe(`chrome-extension://${DESK_EXTENSION_ID}/`);
  });

  it("the rendered manifest's version is MAJOR.MINOR.PATCH.<render serial> and its version_name the full Desk version", () => {
    const rendered = renderManifest({
      template: template(),
      deskVersion: "0.3.1-dev.slice-1c-walking-skeleton+a1b2c3d",
      serial: 42,
      toggleKey: "Command+Shift+Period",
      platform: "darwin",
    });

    expect(rendered).toMatchObject({ ok: true, version: "0.3.1.42" });
    if (!rendered.ok) return;
    expect(rendered.manifest.version).toBe("0.3.1.42");
    expect(rendered.manifest.version_name).toBe("0.3.1-dev.slice-1c-walking-skeleton+a1b2c3d");
    expect(rendered.manifest.key).toBe(KEY);
    expect(extensionIdFromKey(String(rendered.manifest.key))).toBe(extensionIdFromKey(KEY));
  });

  it.each([
    ["darwin", "Command+Shift+Comma", { mac: "Command+Shift+Comma", default: "Ctrl+Shift+Period" }],
    ["linux", "Ctrl+Shift+Comma", { mac: "Command+Shift+Period", default: "Ctrl+Shift+Comma" }],
  ])("the toggle key from config is written into the manifest's suggested_key (on %s, %s)", (platform, toggleKey, suggested) => {
    const rendered = renderManifest({ template: template(), deskVersion: "0.3.0", serial: 1, toggleKey, platform });

    expect(rendered.ok && rendered.manifest.commands).toEqual({
      "toggle-terminal": { suggested_key: suggested, description: "Show, focus, or hide the Desk terminal" },
    });
  });

  it("rendering never changes the template it was given", () => {
    const original = template();
    renderManifest({ template: original, deskVersion: "0.3.0", serial: 7, toggleKey: "Command+Shift+Comma", platform: "darwin" });

    expect(original).toEqual(template());
  });

  it.each([
    ["a version that is not SemVer", { deskVersion: "v0.3.0" }, "bad-version"],
    ["a version part above 65535", { deskVersion: "0.65536.0" }, "bad-version"],
    ["a serial above 65535", { serial: 65_536 }, "bad-serial"],
    ["a negative serial", { serial: -1 }, "bad-serial"],
    ["a template without a key", { template: { ...template(), key: undefined } }, "bad-template"],
    ["a template that is not an object", { template: [] }, "bad-template"],
  ])("rendering refuses %s", (_label, change, reason) => {
    const input = { template: template(), deskVersion: "0.3.0", serial: 1, toggleKey: "Command+Shift+Period", platform: "darwin", ...change };

    expect(renderManifest(input)).toEqual({ ok: false, reason });
  });
});

describe("render.json", () => {
  const source = { deskVersion: "0.3.0", toggleKey: "Command+Shift+Period" };

  it("the first render takes serial 1", () => {
    expect(nextRenderState(null, source)).toEqual({ changed: true, state: { version: 1, serial: 1, ...source } });
  });

  it("a launch that renders the same version with the same toggle key keeps the serial", () => {
    const state: RenderState = { version: 1, serial: 9, ...source };

    expect(nextRenderState(state, source)).toEqual({ changed: false, state });
  });

  it.each([
    ["another Desk version", { ...source, deskVersion: "0.3.1" }],
    ["another toggle key", { ...source, toggleKey: "Command+Shift+Comma" }],
  ])("a render for %s counts the serial up", (_label, next) => {
    expect(nextRenderState({ version: 1, serial: 9, ...source }, next)).toEqual({ changed: true, state: { version: 1, serial: 10, ...next } });
  });

  it("the render serial wraps below 65,536", () => {
    expect(nextRenderState({ version: 1, serial: 65_535, ...source }, { ...source, deskVersion: "0.3.1" }).state.serial).toBe(0);
  });

  it("render.json round-trips, and a file that does not parse or has another shape reads as no render", () => {
    const state: RenderState = { version: 1, serial: 3, ...source };

    expect(parseRenderState(serializeRenderState(state))).toEqual(state);
    expect(parseRenderState("{")).toBeNull();
    expect(parseRenderState(JSON.stringify({ ...state, extra: 1 }))).toBeNull();
    expect(parseRenderState(JSON.stringify({ ...state, serial: 70_000 }))).toBeNull();
    expect(parseRenderState(JSON.stringify({ ...state, version: 2 }))).toBeNull();
  });
});
