/** One installed version as `installed.json` records it (§23.5). */
export type InstalledVersion = {
  channel: string;
  /** The build id: the sha256 of the version's files.sha256. */
  build: string;
  /** Where it came from: `dev` for npm run deploy, else the workflow and ref that built it. */
  provenance: string;
  commit: string;
  installedAt: string;
};

/**
 * `~/.desk/installed.json` (§4.1, §23.5): written only under `run/install.lock`. It only ever gains optional keys, and a
 * Desk writes back the keys it does not know, so its `version` stays 1 (D48).
 */
export type Installed = {
  version: 1;
  current: string | null;
  previous: string | null;
  versions: Record<string, InstalledVersion>;
  files: unknown[];
  [unknown: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isVersionName = (value: unknown) => value === null || typeof value === "string";

/** installed.json with every key kept, or `null` when it does not parse or its known keys are malformed. */
export function parseInstalled(text: string): Installed | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(json) || json.version !== 1) return null;
  if (!isVersionName(json.current) || !isVersionName(json.previous) || !isRecord(json.versions)) return null;
  if (!Array.isArray(json.files)) return null;
  return json as Installed;
}

/**
 * installed.json after installing `entry`: recorded among the versions, and when it becomes current the version that
 * was current becomes previous. Unknown keys stay as they were.
 */
export function nextInstalled(previous: Installed | null, entry: InstalledVersion & { version: string }, makeCurrent: boolean): Installed {
  const base: Installed = previous ?? { version: 1, current: null, previous: null, versions: {}, files: [] };
  const { version, ...recorded } = entry;
  const versions = { ...base.versions, [version]: recorded };
  if (!makeCurrent || base.current === version) return { ...base, versions };
  return { ...base, current: version, previous: base.current, versions };
}

export function serializeInstalled(state: Installed): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}
