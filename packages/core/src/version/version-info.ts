import { parseSemver } from "../release/semver.ts";

/** What a build is, as the stamp wrote it into `version.json` (docs/IMPLEMENTATION.md §23.4). */
export type VersionInfo = {
  version: string;
  channel: "stable" | "edge" | "pr" | "dev";
  branch: string | null;
  commit: string;
  dirty: boolean;
  builtAt: string;
  /** Desk Terminal's Node. */
  node: string;
  /** The protocol range and state-file versions this build reads. */
  compat: unknown;
};

const CHANNELS: readonly string[] = ["stable", "edge", "pr", "dev"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The installed copy's `version.json`, or `null` when it is missing a field or one is malformed: Desk then treats the
 * install as damaged (§23.4). Parser errors are never passed on.
 */
export function parseVersionInfo(text: string): VersionInfo | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;
  const { version, channel, branch, commit, dirty, builtAt, node, compat } = json;
  if (typeof version !== "string" || parseSemver(version) === null) return null;
  if (typeof channel !== "string" || !CHANNELS.includes(channel)) return null;
  if (branch !== null && (typeof branch !== "string" || branch.length > 255)) return null;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) return null;
  if (typeof dirty !== "boolean") return null;
  if (typeof builtAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(builtAt)) return null;
  if (typeof node !== "string" || !/^\d+\.\d+\.\d+$/.test(node)) return null;
  if (!isRecord(compat)) return null;
  return { version, channel: channel as VersionInfo["channel"], branch, commit, dirty, builtAt, node, compat };
}

/**
 * `desk --version`'s line (§23.4, cloud-agents' style): `desk 0.3.1-edge.57+a1b2c3d (edge, a1b2c3d4e5f6 on main, built
 * 2026-10-06T18:00:00Z)`, naming a dirty build as dirty.
 */
export function versionLine(info: VersionInfo): string {
  const where = info.branch === null ? info.commit.slice(0, 12) : `${info.commit.slice(0, 12)} on ${info.branch}`;
  const dirty = info.dirty ? ", dirty" : "";
  return `desk ${info.version} (${info.channel}, ${where}${dirty}, built ${info.builtAt})`;
}
