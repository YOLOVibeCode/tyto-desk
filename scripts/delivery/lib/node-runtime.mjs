/**
 * Desk Terminal's pinned Node (docs/IMPLEMENTATION.md §15.1, §23.6, D49): `scripts/delivery/node-runtime.json` names the
 * version and, per platform, nodejs.org's archive and the sha256 of the archive and of its `bin/node`. The runtime
 * build copies a Node binary only when its sha256 is the pinned one, and the stamp records the pinned version. It lives
 * under scripts/delivery/, an owner-merge path, with the stamp that reads it (D61).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** @typedef {{ archive: string; archiveSha256: string; binarySha256: string }} NodePin */
/** @typedef {{ version: string; source: string; platforms: Record<string, NodePin> }} NodeRuntime */

const HEX64 = /^[0-9a-f]{64}$/;
/** An exact version: no range, no leading zero. */
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** The platforms Desk Terminal ships for (darwin-arm64) and the test container runs (linux-arm64): exactly these. */
const PLATFORMS = ["darwin-arm64", "linux-arm64"];

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The pin, checked (the security reviews of PR #8): an exact `X.Y.Z` version; `source` nodejs.org's own directory for
 * it; exactly the darwin-arm64 and linux-arm64 entries; each archive nodejs.org's own name for that version and
 * platform, so no field can name a path or another build; lowercase sha256 digests. Anything else throws one line: no
 * build goes ahead on a pin it cannot trust.
 * @param {unknown} json
 * @returns {NodeRuntime}
 */
export function parseNodeRuntime(json) {
  if (!isRecord(json)) throw new Error("node-runtime.json is not an object");
  const { version, source, platforms } = json;
  if (typeof version !== "string" || !VERSION.test(version)) throw new Error("node-runtime.json names no exact Node version");
  if (source !== `https://nodejs.org/dist/v${version}/`) throw new Error(`node-runtime.json's source is not https://nodejs.org/dist/v${version}/`);
  if (!isRecord(platforms)) throw new Error("node-runtime.json has no platforms");
  const keys = Object.keys(platforms);
  const unknown = keys.filter((key) => !PLATFORMS.includes(key));
  if (unknown.length > 0) throw new Error(`node-runtime.json names a platform Desk does not build for: ${unknown.join(", ")}`);
  /** @type {Record<string, NodePin>} */
  const checked = {};
  for (const key of PLATFORMS) {
    if (!keys.includes(key)) throw new Error(`node-runtime.json has no ${key} entry`);
    const pin = platforms[key];
    if (!isRecord(pin)) throw new Error(`node-runtime.json's ${key} entry is malformed`);
    const { archive, archiveSha256, binarySha256 } = pin;
    if (archive !== `node-v${version}-${key}.tar.gz` && archive !== `node-v${version}-${key}.tar.xz`) {
      throw new Error(`node-runtime.json's ${key} archive is not nodejs.org's node-v${version}-${key} tarball`);
    }
    if (typeof archiveSha256 !== "string" || !HEX64.test(archiveSha256) || typeof binarySha256 !== "string" || !HEX64.test(binarySha256)) {
      throw new Error(`node-runtime.json's ${key} entry is malformed`);
    }
    checked[key] = { archive, archiveSha256, binarySha256 };
  }
  return { version, source, platforms: checked };
}

/**
 * The pin from `scripts/delivery/node-runtime.json`, checked by `parseNodeRuntime`; a missing file or one that is not
 * JSON throws one line too.
 * @param {string} root the checkout
 * @returns {Promise<NodeRuntime>}
 */
export async function readNodeRuntime(root) {
  /** @type {string} */
  let text;
  try {
    text = await readFile(join(root, "scripts", "delivery", "node-runtime.json"), "utf8");
  } catch {
    throw new Error("scripts/delivery/node-runtime.json cannot be read");
  }
  /** @type {unknown} */
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("node-runtime.json is not JSON");
  }
  return parseNodeRuntime(json);
}

/**
 * The pin for a platform and architecture, or `null` where Desk Terminal has none: darwin-arm64 for the Mac, and
 * linux-arm64 for the test container only.
 * @param {NodeRuntime} runtime
 * @param {string} platform
 * @param {string} arch
 * @returns {NodePin | null}
 */
export function nodePin(runtime, platform, arch) {
  return Object.hasOwn(runtime.platforms, `${platform}-${arch}`) ? (runtime.platforms[`${platform}-${arch}`] ?? null) : null;
}
