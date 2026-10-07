import { parseSemver } from "../release/semver.ts";

/** An MV3 `version` takes one to four dot-separated integers, each at most 65535. */
const VERSION_PART_MAX = 65_535;

export type RenderManifestInput = {
  /** packages/extension/manifest.json as the installed version ships it: `version` is a placeholder. */
  template: unknown;
  /** The full Desk version, from the installed version's version.json. */
  deskVersion: string;
  /** render.json's serial (§23.3). */
  serial: number;
  /** `config.panel.toggleKey`, which the config schema accepts only in a shape Chrome's manifest parser accepts. */
  toggleKey: string;
  platform: string;
};

/**
 * - `bad-template`: the template is not a JSON object with a `key`.
 * - `bad-version`: the Desk version is not SemVer, or a part of it is above 65535.
 * - `bad-serial`: the serial is not an integer from 0 to 65535.
 */
export type RenderManifestResult =
  | { ok: true; manifest: Record<string, unknown>; version: string }
  | { ok: false; reason: "bad-template" | "bad-version" | "bad-serial" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A deep copy of JSON data, so the rendered manifest never shares an object with the template. */
function copyJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyJson);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyJson(item)]));
  return value;
}

/** `X.Y.Z.<serial>` from a Desk version, or `null` when MV3 cannot carry it. */
function manifestVersion(deskVersion: string, serial: number): string | null {
  const version = parseSemver(deskVersion);
  if (version === null) return null;
  const parts = [version.major, version.minor, version.patch];
  if (parts.some((part) => part > VERSION_PART_MAX)) return null;
  return `${parts.join(".")}.${serial}`;
}

/**
 * The manifest Chrome loads from `~/.desk/extension` (docs/IMPLEMENTATION.md §6.1 step 5, §9, §23.3): the installed
 * version's template with `version` `X.Y.Z.<render serial>`, `version_name` the full Desk version, and the configured
 * toggle key as the toggle command's suggested key for this platform (`mac` on macOS, `default` elsewhere). The key, and
 * so the id, is the template's. The template is never changed.
 */
export function renderManifest(input: RenderManifestInput): RenderManifestResult {
  if (!isRecord(input.template) || typeof input.template.key !== "string" || input.template.key === "") {
    return { ok: false, reason: "bad-template" };
  }
  if (!Number.isInteger(input.serial) || input.serial < 0 || input.serial > VERSION_PART_MAX) {
    return { ok: false, reason: "bad-serial" };
  }
  const version = manifestVersion(input.deskVersion, input.serial);
  if (version === null) return { ok: false, reason: "bad-version" };
  const manifest = copyJson(input.template) as Record<string, unknown>;
  manifest.version = version;
  manifest.version_name = input.deskVersion;
  const toggle = isRecord(manifest.commands) ? manifest.commands["toggle-terminal"] : undefined;
  if (isRecord(toggle)) {
    const suggested = isRecord(toggle.suggested_key) ? toggle.suggested_key : {};
    suggested[input.platform === "darwin" ? "mac" : "default"] = input.toggleKey;
    toggle.suggested_key = suggested;
  }
  return { ok: true, manifest, version };
}
